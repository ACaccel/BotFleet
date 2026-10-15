/**
 * The Express app behind the earthquake alert API.
 *
 * The bearer token is checked before anything else, including the route, so
 * an unauthenticated caller learns nothing. An alert whose arrival time is
 * well in the past is a test or a replay: it is acknowledged without posting,
 * which turns the warning app's test button into an end-to-end check. Request
 * headers are never logged and responses never echo the token.
 */
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import type { Logger } from '../../../core/logger';
import type { Clock } from '../../../core/time';
import type { AlertDispatcher } from './alert-dispatcher';
import { EarthquakeAlertSchema } from './alert-request';

const BODY_LIMIT = '4kb';
/** Field paths reported for an invalid body; enough to locate the mistake. */
const REPORTED_ISSUES = 5;
/**
 * How far the arrival time may lie from the server clock. Older alerts are
 * tests or replays; later ones cannot be real early warnings.
 */
export const ARRIVAL_WINDOW_SECONDS = 600;

export interface AlertAppDeps {
  readonly isAuthorized: (header: string | undefined) => boolean;
  readonly dispatcher: AlertDispatcher;
  readonly clock: Clock;
  readonly logger: Logger;
}

const fail = (res: Response, status: number, error: string): void => {
  res.status(status).json({ error });
};

export const buildAlertApp = (deps: AlertAppDeps): Express => {
  const app = express();
  app.disable('x-powered-by');

  const authorize: RequestHandler = (req, res, next) => {
    if (deps.isAuthorized(req.get('authorization'))) {
      next();
      return;
    }
    deps.logger.warn('earthquake alert: unauthorized request');
    res.set('WWW-Authenticate', 'Bearer');
    fail(res, 401, 'unauthorized');
  };

  const receive: RequestHandler = (req, res, next) => {
    const parsed = EarthquakeAlertSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid body',
        fields: parsed.error.issues
          .slice(0, REPORTED_ISSUES)
          .map((issue) => issue.path.join('.') || '(root)'),
      });
      return;
    }
    const alert = parsed.data;
    const nowSeconds = Math.floor(deps.clock.now() / 1000);
    const summary = {
      magnitude: alert.magnitude,
      maxIntensity: alert.maxIntensity,
      localIntensity: alert.localIntensity,
      remainingSeconds: alert.remainingSeconds,
    };
    if (alert.arrivalTime < nowSeconds - ARRIVAL_WINDOW_SECONDS) {
      deps.logger.info({ result: 'test', ...summary }, 'earthquake alert: test or replay');
      res.status(200).json({ result: 'test' });
      return;
    }
    if (alert.arrivalTime > nowSeconds + ARRIVAL_WINDOW_SECONDS) {
      deps.logger.warn({ ...summary }, 'earthquake alert: arrival time too far ahead');
      fail(res, 400, 'arrival time out of range');
      return;
    }
    deps.dispatcher
      .dispatch(alert)
      .then((outcome) => {
        if (outcome.kind === 'not_ready') {
          deps.logger.warn('earthquake alert: discord client not ready');
          fail(res, 503, 'discord client not ready');
          return;
        }
        const result = outcome.created ? 'created' : 'updated';
        deps.logger.info(
          { result, pinged: outcome.pinged, guilds: outcome.guilds, ...summary },
          'earthquake alert: delivered',
        );
        res.status(200).json({ result, pinged: outcome.pinged, guilds: outcome.guilds });
      })
      .catch(next);
  };

  app.use(authorize);
  app.post('/alerts', express.json({ limit: BODY_LIMIT }), receive);

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
    deps.logger.error({ err: error }, 'earthquake alert: request failed');
    fail(res, 500, 'internal error');
  });

  return app;
};
