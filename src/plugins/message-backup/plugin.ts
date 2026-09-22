/**
 * MessageBackupPlugin — periodic per-guild message backup.
 *
 * The plugin owns the full backup logic; the `MsgArchive` composition
 * root simply registers it. The hot loop and its helpers (channel
 * fetch, the outage-tolerant retry policy, pagination, log file format,
 * stale-Fetch-doc cleanup) live in `internal/` so this file stays
 * lifecycle wiring only.
 *
 * Wiring:
 *   - Reads `backupServers` config — the list of guild ids the bot
 *     should back up.
 *   - Reads the optional `backupIntervalMs` config — the delay between
 *     repeat passes. Defaults to one hour when omitted, preserving the
 *     historical hard-coded cadence.
 *   - Reads the optional `backupLogEnabled` flag — defaults to `false`. The
 *     backup always runs; this only controls whether each pass writes its
 *     per-guild transcript to `logs/backup/`. The composition root maps the
 *     operator-facing `backup_log_enabled` config field onto it.
 *   - Schedules itself on `onReady` (one-shot per guild then a repeat
 *     loop on `backupIntervalMs`). `onShutdown` clears the loop so a
 *     fast restart does not double-trigger.
 *
 * One instance covers every guild: the backup batches all configured
 * guilds in series to keep request-rate predictable. A per-guild
 * variant would race against itself on the Mongo connection pool.
 */
import { TOKENS } from '../../bot/tokens';
import { logError } from '../../core/logger';
import type { Plugin } from '../../core/plugin';
import { performBackup } from './internal';

const PLUGIN_ID = 'message-backup';
const PLUGIN_VERSION = '1.0.0';
const DEFAULT_BACKUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
// Node's `setTimeout` ceiling (2^31 - 1 ms, ~24.8 days). A delay above
// this overflows the internal 32-bit counter and is silently coerced to
// 1ms, which would turn the repeat loop into a near-tight spin. Reject
// such values at construction instead.
const MAX_TIMEOUT_MS = 2_147_483_647;

interface MessageBackupPluginConfig {
  readonly backupServers: readonly string[];
  /**
   * Delay between repeat backup passes, in milliseconds. Omit to keep
   * the historical one-hour cadence. The composition root converts the
   * operator-facing `backup_interval_minutes` config field into this.
   */
  readonly backupIntervalMs?: number;
  /**
   * Whether each backup pass writes its per-guild transcript to `logs/backup/`.
   * Defaults to `false` — the backup itself always runs; this only gates the
   * transcript file. The composition root maps the operator-facing
   * `backup_log_enabled` config field onto this.
   */
  readonly backupLogEnabled?: boolean;
}

export const createMessageBackupPlugin = (rawConfig: MessageBackupPluginConfig): Plugin => {
  // Transcript logging is opt-in (default off); the backup pass itself always runs.
  const backupLogEnabled = rawConfig.backupLogEnabled ?? false;
  const intervalMs = rawConfig.backupIntervalMs ?? DEFAULT_BACKUP_INTERVAL_MS;
  // Contract guard: a non-positive or non-finite interval would turn the
  // repeat loop into a tight spin (0ms) or never fire (NaN/Infinity); a
  // value above Node's timer ceiling overflows to a 1ms spin (see
  // MAX_TIMEOUT_MS).
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > MAX_TIMEOUT_MS) {
    throw new TypeError(
      `createMessageBackupPlugin: backupIntervalMs must be a positive finite number <= ${String(MAX_TIMEOUT_MS)}ms, got ${String(intervalMs)}`,
    );
  }
  const config: Required<Pick<MessageBackupPluginConfig, 'backupServers' | 'backupIntervalMs'>> = {
    backupServers: [...rawConfig.backupServers],
    backupIntervalMs: intervalMs,
  };
  const running = new Set<string>();
  let loopHandle: NodeJS.Timeout | undefined;
  let stopped = false;

  return {
    id: PLUGIN_ID,
    version: PLUGIN_VERSION,

    async onReady(ctx): Promise<void> {
      const registry = ctx.resolve(TOKENS.GuildRegistry);
      const client = ctx.resolve(TOKENS.DiscordClient);

      const runOnce = async (): Promise<void> => {
        for (const guildId of config.backupServers) {
          if (stopped) return;
          if (running.has(guildId)) {
            logError(ctx.logger, guildId, 'Backup already running, skipping this tick');
            continue;
          }
          running.add(guildId);
          try {
            await performBackup(guildId, registry, client, ctx.logger, backupLogEnabled);
          } catch (err: unknown) {
            // Isolate a per-guild failure: one guild's error must not
            // abort the remaining guilds in this pass, nor reject the
            // scheduling loop above.
            logError(ctx.logger, guildId, err);
          } finally {
            running.delete(guildId);
          }
        }
      };

      const runPass = async (): Promise<void> => {
        try {
          await runOnce();
        } catch (err: unknown) {
          logError(ctx.logger, null, err);
        } finally {
          if (!stopped) {
            loopHandle = setTimeout(() => {
              void runPass();
            }, config.backupIntervalMs);
          }
        }
      };
      // Readiness means the worker is initialized, not that its history walk finished.
      void runPass();
    },

    async onShutdown(): Promise<void> {
      stopped = true;
      if (loopHandle !== undefined) {
        clearTimeout(loopHandle);
        loopHandle = undefined;
      }
    },
  };
};
