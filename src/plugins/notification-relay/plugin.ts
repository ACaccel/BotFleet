/**
 * NotificationRelayPlugin — a loopback HTTP API through which local
 * services (such as a deployment controller) post a progress notification
 * to a configured Discord channel and then keep editing that one message.
 *
 * `PUT /notifications/:route/:key` posts the first update for a route and
 * caller key, and edits the same message afterwards; see `internal/` for
 * the request contract, rendering and delivery.
 *
 * Assembled only by `konata`. Without a port the plugin logs that it is
 * disabled and does nothing. `start` binds the server rather than
 * `onReady`, so a taken port or a missing database disables the plugin
 * during startup, where deployment readiness reports it; requests that
 * arrive before the Discord client is ready are answered with 503.
 * `onShutdown` closes the server within the shutdown budget.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { TOKENS } from '../../bot/tokens';
import { NOTIFY_API_KEY_MIN_LENGTH } from '../../core/config';
import { closeServerBounded, createBearerCheck } from '../../core/http';
import { asGuildId } from '../../core/ids';
import { logError, logSystem } from '../../core/logger';
import type { Plugin } from '../../core/plugin';
import {
  MongoNotificationThreadRepo,
  type NotificationThreadRepo,
} from '../../persistence/repositories/notification-thread.repo';
import { buildNotificationApp, createNotificationRelay, parseNotificationRoutes } from './internal';

const PLUGIN_ID = 'notification-relay';
const PLUGIN_VERSION = '1.0.0';

/** The API is for services on the same host only. */
const LISTEN_HOST = '127.0.0.1';

/** Configuration for {@link createNotificationRelayPlugin}. */
interface NotificationRelayPluginConfig {
  /** The relaying bot's application ID; scopes stored threads per bot. */
  readonly botId: string;
  /** Loopback port (`NOTIFY_API_PORT`); the API is disabled without it. */
  readonly port?: number | undefined;
  /** Bearer secret (`NOTIFY_API_KEY`); required with a port. */
  readonly apiKey?: string | undefined;
  /** The bot's raw `notificationRoutes` block. */
  readonly routes?: unknown;
}

/** Optional collaborators for tests. */
interface NotificationRelayPluginDeps {
  /** Replaces the MongoDB thread store of a route guild. */
  readonly store?: (guildId: string) => Promise<NotificationThreadRepo>;
}

/**
 * Build the notification relay plugin. Routes and the port/key pair are
 * validated here, so a malformed configuration stops startup.
 */
export const createNotificationRelayPlugin = (
  config: NotificationRelayPluginConfig,
  deps: NotificationRelayPluginDeps = {},
): Plugin => {
  const routes = parseNotificationRoutes(config.routes);
  const { port, apiKey } = config;
  if (port !== undefined && (apiKey === undefined || apiKey.length < NOTIFY_API_KEY_MIN_LENGTH)) {
    throw new Error(
      `notification relay needs an API key of at least ${NOTIFY_API_KEY_MIN_LENGTH} characters`,
    );
  }
  let server: Server | undefined;

  return {
    id: PLUGIN_ID,
    version: PLUGIN_VERSION,

    async start(ctx): Promise<void> {
      if (port === undefined || apiKey === undefined) {
        logSystem(ctx.logger, 'NOTIFY_API_PORT is not set; notification relay API is disabled');
        return;
      }
      const store =
        deps.store ??
        (() => {
          const connections = ctx.resolve(TOKENS.ConnectionManager);
          return async (guildId: string): Promise<NotificationThreadRepo> =>
            new MongoNotificationThreadRepo(await connections.getConnection(asGuildId(guildId)));
        })();
      const relay = createNotificationRelay({
        client: ctx.resolve(TOKENS.DiscordClient),
        botId: config.botId,
        store,
        translator: ctx.translator,
        clock: ctx.clock,
        logger: ctx.logger,
      });
      const app = buildNotificationApp({
        routes,
        isAuthorized: createBearerCheck(apiKey),
        relay,
        logger: ctx.logger,
      });

      await new Promise<void>((resolve, reject) => {
        const listening = app.listen(port, LISTEN_HOST, () => {
          // Report the bound port: it differs from the configured one when that is 0.
          const bound = (listening.address() as AddressInfo).port;
          logSystem(
            ctx.logger,
            `notification relay API is listening on ${LISTEN_HOST}:${bound} with ${routes.size} route(s)`,
          );
          // Startup is settled; later socket errors are runtime events to log.
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
          'notification relay API did not close within the shutdown budget; continuing',
        );
      });
      logSystem(ctx.logger, 'notification relay API closed');
    },
  };
};
