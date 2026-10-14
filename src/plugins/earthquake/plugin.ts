/**
 * EarthquakePlugin — owns the two earthquake feeds for a guild's
 * `earthquake` channel:
 *   - the early warning: a `/discord/earthquake` HTTP webhook that the
 *     owner's warning app calls, which pings the guild's earthquake role;
 *   - the CWA significant earthquake report, polled from the open-data
 *     API once a minute and posted as an embed that pings nobody.
 *
 * Assembled only by `nijika`. `start` stands up the Express server;
 * `onReady` starts the report poller (guild channels resolve only once
 * the client is ready); `onShutdown` stops the poller and closes the
 * server so a fast restart leaks neither a timer nor the listening
 * socket. Fetching, parsing, rendering and fan-out live in `internal/`,
 * so this file is lifecycle wiring only.
 *
 * Why a factory: the listen `port` and the CWA key are per-bot
 * configuration captured into the closure, mirroring the
 * `createMessageBackupPlugin` pattern. Without a key the poller stays
 * off and the webhook works alone.
 */
import express, { type Express } from 'express';
import type { Server } from 'node:http';

import { TOKENS } from '../../bot/tokens';
import { closeServerBounded } from '../../core/http';
import { logError, logSystem } from '../../core/logger';
import type { Plugin } from '../../core/plugin';
import {
  broadcastEarthquakeAlert,
  broadcastEarthquakeReport,
  createReportPoller,
  fetchSignificantReports,
  startReportPolling,
  type ParsedReports,
} from './internal';

const PLUGIN_ID = 'earthquake';
const PLUGIN_VERSION = '1.1.0';

/** Delay between report polls; CWA reports appear minutes after a quake. */
const REPORT_POLL_INTERVAL_MS = 60_000;

/** Configuration for {@link createEarthquakePlugin}. */
interface EarthquakePluginConfig {
  /** TCP port the earthquake webhook server listens on. */
  readonly port: number;
  /** CWA open-data API key; the report poller is disabled without it. */
  readonly cwaApiKey?: string | undefined;
}

/** Optional collaborators for tests. */
interface EarthquakePluginDeps {
  /** Replaces the CWA HTTP fetch; receives the configured key. */
  readonly fetchReports?: (apiKey: string) => Promise<ParsedReports>;
}

/**
 * Build the earthquake plugin. The returned object is pure data; all
 * mutable state (the HTTP server and poll-loop handles) is captured in
 * the closure.
 */
export const createEarthquakePlugin = (
  rawConfig: EarthquakePluginConfig,
  deps: EarthquakePluginDeps = {},
): Plugin => {
  const config: EarthquakePluginConfig = { port: rawConfig.port, cwaApiKey: rawConfig.cwaApiKey };
  const fetchReports = deps.fetchReports ?? fetchSignificantReports;
  let server: Server | undefined;
  let reportPolling: { stop(): void } | undefined;

  return {
    id: PLUGIN_ID,
    version: PLUGIN_VERSION,

    async start(ctx): Promise<void> {
      const client = ctx.resolve(TOKENS.DiscordClient);
      const registry = ctx.resolve(TOKENS.GuildRegistry);

      const app: Express = express();
      app.use(express.json());
      const router = express.Router();
      app.use('/discord', router);

      router.get('/', (_req, res) => {
        res.status(200).send('Hello World!');
      });

      router.post('/earthquake', (_req, res) => {
        logSystem(ctx.logger, 'Earthquake alert webhook received; broadcasting.');
        // Respond 200 immediately; the per-guild broadcast runs
        // detached. `broadcastEarthquakeAlert` isolates each guild's
        // failure internally, so a single async IIFE with a defensive
        // catch is enough to keep this off the unhandledRejection path.
        void (async () => {
          try {
            await broadcastEarthquakeAlert(client, registry, ctx.translator, ctx.logger);
          } catch (err: unknown) {
            logError(ctx.logger, null, err);
          }
        })();
        res.status(200).send('OK');
      });

      await new Promise<void>((resolve, reject) => {
        const listening = app.listen(config.port, () => {
          logSystem(ctx.logger, `earthquake webhook server is running on port ${config.port}`);
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

    async onReady(ctx): Promise<void> {
      const apiKey = config.cwaApiKey;
      if (apiKey === undefined) {
        logSystem(ctx.logger, 'CWA_API_KEY is not set; earthquake report polling is disabled');
        return;
      }
      const client = ctx.resolve(TOKENS.DiscordClient);
      const registry = ctx.resolve(TOKENS.GuildRegistry);
      const poller = createReportPoller({
        fetchReports: () => fetchReports(apiKey),
        publish: (report) =>
          broadcastEarthquakeReport(client, registry, report, ctx.translator, ctx.logger),
        logger: ctx.logger,
      });
      reportPolling = startReportPolling(poller, REPORT_POLL_INTERVAL_MS, ctx.logger);
      logSystem(ctx.logger, 'earthquake report polling started');
    },

    async onShutdown(ctx): Promise<void> {
      reportPolling?.stop();
      reportPolling = undefined;
      if (server === undefined) return;
      const listening = server;
      server = undefined;
      await closeServerBounded(listening, () => {
        logSystem(
          ctx.logger,
          'earthquake webhook server did not close within the shutdown budget; continuing',
        );
      });
      logSystem(ctx.logger, 'earthquake webhook server closed');
    },
  };
};
