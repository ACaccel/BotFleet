/**
 * EarthquakePlugin — owns the two earthquake feeds for a guild's
 * `earthquake` channel:
 *   - early warnings: `POST /alerts` on a loopback HTTP API that the
 *     owner's warning app reaches through a caller script, posting an embed
 *     that pings the guild's `earthquake` role from the configured local
 *     intensity (`earthquake_alert.ping_min_local_intensity`, default 4);
 *   - the CWA significant earthquake report, polled from the open-data
 *     API once a minute and posted as an embed that pings nobody.
 *
 * Assembled only by `nijika`. Each feed is optional: without an alert port
 * the API stays off, and without a CWA key the poller does. `start` binds
 * the server, so a taken port fails startup; requests that arrive before
 * the Discord client is ready are answered with 503. `onReady` starts the
 * report poller (guild channels resolve only once the client is ready);
 * `onShutdown` stops the poller and closes the server so a fast restart
 * leaks neither a timer nor the listening socket. Validation, delivery and
 * rendering live in `internal/`, so this file is lifecycle wiring only.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { TOKENS } from '../../bot/tokens';
import { EARTHQUAKE_ALERT_KEY_MIN_LENGTH } from '../../core/config';
import { closeServerBounded, createBearerCheck } from '../../core/http';
import { logError, logSystem } from '../../core/logger';
import type { Plugin } from '../../core/plugin';
import {
  broadcastEarthquakeReport,
  buildAlertApp,
  createAlertDispatcher,
  createReportPoller,
  fetchSignificantReports,
  parseEarthquakeAlertConfig,
  startReportPolling,
  type ParsedReports,
} from './internal';

const PLUGIN_ID = 'earthquake';
const PLUGIN_VERSION = '2.0.0';

/** The alert API is reached through a local reverse proxy only. */
const LISTEN_HOST = '127.0.0.1';

/** Delay between report polls; CWA reports appear minutes after a quake. */
const REPORT_POLL_INTERVAL_MS = 60_000;

/** Configuration for {@link createEarthquakePlugin}. */
interface EarthquakePluginConfig {
  /** Loopback port (`EARTHQUAKE_ALERT_PORT`); the alert API is disabled without it. */
  readonly alertPort?: number | undefined;
  /** Bearer secret (`EARTHQUAKE_ALERT_KEY`); required with a port. */
  readonly alertKey?: string | undefined;
  /** CWA open-data API key; the report poller is disabled without it. */
  readonly cwaApiKey?: string | undefined;
  /** The bot's raw `earthquake_alert` block; absent means the defaults. */
  readonly alertConfig?: unknown;
}

/** Optional collaborators for tests. */
interface EarthquakePluginDeps {
  /** Replaces the CWA HTTP fetch; receives the configured key. */
  readonly fetchReports?: (apiKey: string) => Promise<ParsedReports>;
}

/**
 * Build the earthquake plugin. The port/key pair and the `earthquake_alert`
 * block are validated here, so a malformed configuration stops startup; all mutable state (the HTTP server
 * and poll-loop handles) is captured in the closure.
 */
export const createEarthquakePlugin = (
  config: EarthquakePluginConfig,
  deps: EarthquakePluginDeps = {},
): Plugin => {
  const { alertPort, alertKey, cwaApiKey } = config;
  const alertSettings = parseEarthquakeAlertConfig(config.alertConfig);
  if (
    alertPort !== undefined &&
    (alertKey === undefined || alertKey.length < EARTHQUAKE_ALERT_KEY_MIN_LENGTH)
  ) {
    throw new Error(
      `earthquake alert API needs a key of at least ${EARTHQUAKE_ALERT_KEY_MIN_LENGTH} characters`,
    );
  }
  const fetchReports = deps.fetchReports ?? fetchSignificantReports;
  let server: Server | undefined;
  let reportPolling: { stop(): void } | undefined;

  return {
    id: PLUGIN_ID,
    version: PLUGIN_VERSION,

    async start(ctx): Promise<void> {
      if (alertPort === undefined || alertKey === undefined) {
        logSystem(ctx.logger, 'EARTHQUAKE_ALERT_PORT is not set; earthquake alert API is disabled');
        return;
      }
      const dispatcher = createAlertDispatcher({
        client: ctx.resolve(TOKENS.DiscordClient),
        registry: ctx.resolve(TOKENS.GuildRegistry),
        translator: ctx.translator,
        clock: ctx.clock,
        logger: ctx.logger,
        pingThreshold: alertSettings.pingMinLocalIntensity,
      });
      const app = buildAlertApp({
        isAuthorized: createBearerCheck(alertKey),
        dispatcher,
        clock: ctx.clock,
        logger: ctx.logger,
      });

      await new Promise<void>((resolve, reject) => {
        const listening = app.listen(alertPort, LISTEN_HOST, () => {
          // Report the bound port: it differs from the configured one when that is 0.
          const bound = (listening.address() as AddressInfo).port;
          logSystem(ctx.logger, `earthquake alert API is listening on ${LISTEN_HOST}:${bound}`);
          // Startup is settled; later socket errors are runtime events to log.
          listening.removeListener('error', reject);
          listening.on('error', (err: Error) => logError(ctx.logger, null, err));
          resolve();
        });
        listening.on('error', reject);
        server = listening;
      });
    },

    async onReady(ctx): Promise<void> {
      if (cwaApiKey === undefined) {
        logSystem(ctx.logger, 'CWA_API_KEY is not set; earthquake report polling is disabled');
        return;
      }
      const client = ctx.resolve(TOKENS.DiscordClient);
      const registry = ctx.resolve(TOKENS.GuildRegistry);
      const poller = createReportPoller({
        fetchReports: () => fetchReports(cwaApiKey),
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
          'earthquake alert API did not close within the shutdown budget; continuing',
        );
      });
      logSystem(ctx.logger, 'earthquake alert API closed');
    },
  };
};
