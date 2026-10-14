/**
 * SettingsApiPlugin — owns a small, authenticated HTTP REST API that lets
 * the operator read and update mutable runtime settings, then persist them
 * back to `config.json`.
 *
 * Scope is intentionally narrow: the only mutable field is the self-hosted
 * LLM `endpoint`, which the operator changes when their LLM host URL moves.
 * Updating it through this API both swaps the live value (the auto-reply
 * client reads it on the next call) and rewrites `config.json` so the
 * change survives a restart. The runtime cell + persistence live in the
 * composition root and are injected here as `getEndpoint` / `setEndpoint`,
 * so this plugin stays generic and never touches the filesystem or knows
 * `config.json`'s path.
 *
 * Security: every request must carry `Authorization: Bearer <apiKey>`,
 * compared in constant time. The key comes from the environment, never
 * `config.json`. When the plugin is enabled but no key was supplied the
 * server refuses to start (fail-closed) — a non-critical skip that logs
 * and leaves the rest of the bot running. The default bind is loopback
 * (see `config.ts`).
 *
 * Factory pattern (mirrors `createEarthquakePlugin`): per-bot settings are
 * parsed once and the HTTP-server handle is captured in the closure, so
 * the returned object is pure data.
 */
import { timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { closeServerBounded } from '../../core/http';
import { logError, logSystem } from '../../core/logger';
import type { Plugin } from '../../core/plugin';
import { parseSettingsApiConfig } from './config';

const PLUGIN_ID = 'settings-api';
const PLUGIN_VERSION = '1.0.0';

/** Request body schema for `PUT {basePath}/endpoint`. */
const EndpointBodySchema = z.object({ endpoint: z.string().url() }).strict();

/** Collaborators wired by the composition root. */
interface CreateSettingsApiDeps {
  /** TCP port the API server listens on (sourced from the validated `Env.PORT`). */
  readonly port: number;
  /**
   * Bearer API key. Read from the environment by the composition root.
   * `undefined`/empty means no key configured — an enabled plugin then
   * refuses to start rather than exposing an unauthenticated endpoint.
   */
  readonly apiKey: string | undefined;
  /** Current self-hosted LLM endpoint. */
  readonly getEndpoint: () => string;
  /** Apply + persist a new endpoint. Rejects if persistence fails. */
  readonly setEndpoint: (url: string) => Promise<void>;
}

/**
 * Constant-time string comparison. Returns false on a length mismatch
 * (length is not secret) before the timing-safe byte compare, since
 * `timingSafeEqual` throws on unequal-length buffers.
 */
const safeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
};

/** Extract the token from an `Authorization: Bearer <token>` header. */
const bearerToken = (req: Request): string | undefined => {
  const header = req.header('authorization');
  if (header === undefined) return undefined;
  const prefix = 'Bearer ';
  return header.startsWith(prefix) ? header.slice(prefix.length) : undefined;
};

export const createSettingsApiPlugin = (
  rawConfig: unknown,
  deps: CreateSettingsApiDeps,
): Plugin => {
  const config = parseSettingsApiConfig(rawConfig);
  let server: Server | undefined;

  return {
    id: PLUGIN_ID,
    version: PLUGIN_VERSION,

    async start(ctx): Promise<void> {
      if (!config.enabled) {
        logSystem(ctx.logger, 'settings-api disabled; HTTP server not started');
        return;
      }
      const apiKey = deps.apiKey;
      if (apiKey === undefined || apiKey.length === 0) {
        // Fail-closed: never expose a settings-mutation endpoint without auth.
        ctx.logger.warn(
          { plugin: PLUGIN_ID },
          'settings-api enabled but no API key configured (GOPHER_SETTINGS_API_KEY); HTTP server not started',
        );
        return;
      }

      const app: Express = express();
      app.use(express.json());
      const router = express.Router();

      // Auth gate: every route under the router requires a valid bearer token.
      router.use((req: Request, res: Response, next: NextFunction) => {
        const token = bearerToken(req);
        if (token === undefined || !safeEqual(token, apiKey)) {
          res.status(401).json({ error: 'unauthorized' });
          return;
        }
        next();
      });

      router.get('/endpoint', (_req: Request, res: Response) => {
        res.status(200).json({ endpoint: deps.getEndpoint() });
      });

      router.put('/endpoint', async (req: Request, res: Response) => {
        const parsed = EndpointBodySchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'invalid_body', detail: 'endpoint must be a valid URL' });
          return;
        }
        try {
          await deps.setEndpoint(parsed.data.endpoint);
          logSystem(ctx.logger, 'settings-api: endpoint updated and persisted');
          res.status(200).json({ endpoint: parsed.data.endpoint });
        } catch (err: unknown) {
          // Express 4 does not await async handlers, so catch here and never
          // let the rejection escape onto the unhandledRejection path.
          logError(ctx.logger, null, err);
          res.status(500).json({ error: 'persist_failed' });
        }
      });

      app.use(config.basePath, router);

      await new Promise<void>((resolve, reject) => {
        // The port is operator-supplied via the validated env (deps.port),
        // not config.json; the bind host is the (non-secret) config field.
        const listening = app.listen(deps.port, config.host, () => {
          // Report the bound port, not the configured one: they differ when
          // the configured port is 0 (OS-assigned).
          const { port } = listening.address() as AddressInfo;
          logSystem(
            ctx.logger,
            `settings-api server listening on ${config.host}:${port}${config.basePath}`,
          );
          // Startup is settled. A socket error from here on is a runtime
          // event, and `reject` would silently discard it against an
          // already-settled promise — swap in a logging handler.
          listening.removeListener('error', reject);
          listening.on('error', (err: Error) => logError(ctx.logger, null, err));
          resolve();
        });
        listening.on('error', reject);
        server = listening;
      });
    },

    async onShutdown(ctx): Promise<void> {
      if (server === undefined) return;
      const listening = server;
      server = undefined;
      await closeServerBounded(listening, () => {
        logSystem(
          ctx.logger,
          'settings-api server did not close within the shutdown budget; continuing',
        );
      });
      logSystem(ctx.logger, 'settings-api server closed');
    },
  };
};
