import { randomUUID } from 'node:crypto';
import { TOKENS } from '../../bot/tokens';
import type { Plugin } from '../../core/plugin';
import { parseArchiveSettings } from './config';
import { ArchiveGatewayDecoder } from './runtime/gateway-event';
import { ArchiveWorker } from './runtime/worker';

interface MessageBackupPluginConfig {
  readonly backupServers: readonly string[];
  readonly backupIntervalMs?: number;
  readonly backupLogEnabled?: boolean;
  readonly policy?: unknown;
  readonly runtime?: unknown;
}

/** Single worker lifecycle for live capture, periodic scans and submitted repair jobs. */
export const createMessageBackupPlugin = (raw: MessageBackupPluginConfig): Plugin => {
  const { interval, config, policy } = parseArchiveSettings(raw);
  const guildIds = [...raw.backupServers];
  const decoder = new ArchiveGatewayDecoder(randomUUID());
  const timers = new Set<NodeJS.Timeout>();
  const running = new Set<Promise<void>>();
  const startedGuilds = new Set<string>();
  let worker: ArchiveWorker | undefined;
  let stopped = false;
  return {
    id: 'message-backup',
    version: '2.0.0',
    async init(ctx) {
      worker = new ArchiveWorker({
        client: ctx.resolve(TOKENS.DiscordClient),
        registry: ctx.resolve(TOKENS.GuildRegistry),
        connections: ctx.resolve(TOKENS.ConnectionManager),
        logger: ctx.logger,
        translator: ctx.translator,
        guildIds,
        config,
        policy,
        backupLogEnabled: raw.backupLogEnabled ?? false,
      });
    },
    async onReady(ctx) {
      for (const guildId of guildIds) {
        if (stopped || startedGuilds.has(guildId)) continue;
        startedGuilds.add(guildId);
        let periodic: Promise<void> | undefined;
        const tick = async (): Promise<void> => {
          if (stopped || worker === undefined) return;
          try {
            await worker.pollJobs(guildId);
            if (!stopped && periodic === undefined) {
              periodic = worker
                .scheduledPeriodic(guildId, interval)
                .catch((error: unknown) => {
                  ctx.logger.error({ guildId, err: error }, 'Archive periodic pass failed');
                })
                .finally(() => {
                  periodic = undefined;
                });
              const work = periodic;
              running.add(work);
              void work.finally(() => running.delete(work)).catch(() => undefined);
            }
          } catch (error) {
            ctx.logger.error({ guildId, err: error }, 'Archive worker pass failed');
          } finally {
            if (!stopped) {
              const handle = setTimeout(() => {
                timers.delete(handle);
                launch();
              }, config.job_poll_seconds * 1000);
              timers.add(handle);
            }
          }
        };
        const launch = (): void => {
          const work = tick();
          running.add(work);
          void work.finally(() => running.delete(work)).catch(() => undefined);
        };
        launch();
      }
    },
    events: {
      async raw(ctx, packet, shardId) {
        if (worker === undefined || stopped) return;
        for (const event of decoder.decode(packet, shardId, Date.now())) {
          try {
            await worker.capture(event);
          } catch (error) {
            ctx.logger.error({ guildId: event.guildId, err: error }, 'Archive event capture gap');
          }
        }
      },
      async shardDisconnect(ctx) {
        if (worker === undefined || stopped) return;
        try {
          await worker.markGap('gateway-disconnect');
        } catch (error) {
          ctx.logger.error({ err: error }, 'Archive disconnect gap could not be persisted');
        }
      },
    },
    async onShutdown() {
      stopped = true;
      for (const handle of timers) clearTimeout(handle);
      timers.clear();
      // Stop admission/REST first; wait until every job and write has drained
      // before relinquishing ownership or closing the shared Mongo connection.
      worker?.cancel();
      await Promise.allSettled([...running]);
      await worker?.stop();
    },
  };
};
