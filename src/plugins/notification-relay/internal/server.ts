/**
 * The Express app behind the notification relay API.
 *
 * Checks run cheapest and least revealing first: route syntax, then the
 * bearer token, and only then route existence, key syntax, body size and
 * body shape, so an unauthenticated caller learns nothing about the
 * configured routes. Responses never echo the token, and request headers
 * are never logged.
 */
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import type { Logger } from '../../../core/logger';
import { ROUTE_NAME_PATTERN, type NotificationRoute } from './config';
import type { NotificationRelay, RelayOutcome } from './relay';
import { NotificationSchema, THREAD_KEY_PATTERN } from './request';

const BODY_LIMIT = '16kb';
/** Field paths reported for an invalid body; enough to locate the mistake. */
const REPORTED_ISSUES = 5;

export interface NotificationAppDeps {
  readonly routes: ReadonlyMap<string, NotificationRoute>;
  readonly isAuthorized: (header: string | undefined) => boolean;
  readonly relay: NotificationRelay;
  readonly logger: Logger;
}

const OUTCOME_RESPONSES: Readonly<
  Record<Exclude<RelayOutcome['kind'], 'delivered'>, { status: number; error: string }>
> = {
  not_ready: { status: 503, error: 'discord client not ready' },
  storage_unavailable: { status: 503, error: 'storage unavailable' },
  misconfigured: { status: 500, error: 'route misconfigured' },
  discord_failed: { status: 502, error: 'discord request failed' },
};

const fail = (res: Response, status: number, error: string): void => {
  res.status(status).json({ error });
};

export const buildNotificationApp = (deps: NotificationAppDeps): Express => {
  const app = express();
  app.disable('x-powered-by');

  const routeOf = (req: Request): NotificationRoute | undefined =>
    deps.routes.get(String(req.params['route']));

  const checkRouteSyntax: RequestHandler = (req, res, next) => {
    if (!ROUTE_NAME_PATTERN.test(String(req.params['route']))) fail(res, 404, 'unknown route');
    else next();
  };

  const authorize: RequestHandler = (req, res, next) => {
    if (deps.isAuthorized(req.get('authorization'))) {
      next();
      return;
    }
    deps.logger.warn({ route: req.params['route'] }, 'notification relay: unauthorized request');
    res.set('WWW-Authenticate', 'Bearer');
    fail(res, 401, 'unauthorized');
  };

  const checkTarget: RequestHandler = (req, res, next) => {
    if (routeOf(req) === undefined) fail(res, 404, 'unknown route');
    else if (!THREAD_KEY_PATTERN.test(String(req.params['key']))) fail(res, 400, 'invalid key');
    else next();
  };

  const relay: RequestHandler = (req, res, next) => {
    const parsed = NotificationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid body',
        fields: parsed.error.issues
          .slice(0, REPORTED_ISSUES)
          .map((issue) => issue.path.join('.') || '(root)'),
      });
      return;
    }
    const routeName = String(req.params['route']);
    const threadKey = String(req.params['key']);
    deps.relay
      .deliver(routeName, routeOf(req) as NotificationRoute, threadKey, parsed.data)
      .then((outcome) => {
        if (outcome.kind === 'delivered') {
          deps.logger.info(
            { route: routeName, threadKey, created: outcome.created, status: parsed.data.status },
            'notification relay: delivered',
          );
          res.status(200).json({ messageId: outcome.messageId, created: outcome.created });
          return;
        }
        const { status, error } = OUTCOME_RESPONSES[outcome.kind];
        fail(res, status, error);
      })
      .catch(next);
  };

  app.put(
    '/notifications/:route/:key',
    checkRouteSyntax,
    authorize,
    checkTarget,
    express.json({ limit: BODY_LIMIT }),
    relay,
  );

  app.use((_req: Request, res: Response) => {
    fail(res, 404, 'not found');
  });

  // Express recognises an error handler by its four parameters.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const type = (error as { type?: unknown } | null)?.type;
    if (type === 'entity.too.large') {
      fail(res, 413, 'body too large');
      return;
    }
    const status = (error as { status?: unknown } | null)?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      fail(res, 400, 'invalid body');
      return;
    }
    deps.logger.error({ err: error }, 'notification relay: request failed');
    fail(res, 500, 'internal error');
  });

  return app;
};
