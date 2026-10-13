import { randomUUID } from 'node:crypto';
import { TOKENS } from '../../bot/tokens';
import type { Plugin } from '../../core/plugin';
import { archiveBackupNotifiers } from './runtime/backup-notifier';
import {
  buildArchiveRepos,
  buildArchiveWriterRepos,
} from '../../persistence/repositories/archive-repos';
import { parseArchiveSettings } from './config';
import { ArchiveGatewayDecoder } from './runtime/gateway-event';
import { clientGatewayReadiness, type ArchiveGatewayReadiness } from './runtime/gateway-readiness';
import { ArchiveWorker } from './runtime/worker';

interface MessageBackupPluginConfig {
  readonly backupServers: readonly string[];
  readonly backupIntervalMs?: number;
  readonly backupLogEnabled?: boolean;
  /** Users the archive's warning and recovery notices mention. */
  readonly adminIds?: readonly string[];
  readonly policy?: unknown;
  readonly runtime?: unknown;
}

/** Single worker lifecycle for live capture, periodic scans and full-backup jobs. */
export const createMessageBackupPlugin = (raw: MessageBackupPluginConfig): Plugin => {
  const { interval, config, policy } = parseArchiveSettings(raw);
  const guildIds = [...raw.backupServers];
  const decoder = new ArchiveGatewayDecoder(randomUUID());
  const timers = new Set<NodeJS.Timeout>();
  const running = new Set<Promise<void>>();
  const startedGuilds = new Set<string>();
  let worker: ArchiveWorker | undefined;
  let gateway: ArchiveGatewayReadiness | undefined;
  let seedingWarned = false;
  let stopped = false;
  return {
    id: 'message-backup',
    version: '2.0.0',
    async init(ctx) {
      const client = ctx.resolve(TOKENS.DiscordClient);
      gateway = clientGatewayReadiness(client);
      worker = new ArchiveWorker({
        client,
        registry: ctx.resolve(TOKENS.GuildRegistry),
        connections: ctx.resolve(TOKENS.ConnectionManager),
        logger: ctx.logger,
        translator: ctx.translator,
        guildIds,
        config,
        policy,
        backupLogEnabled: raw.backupLogEnabled ?? false,
        adminIds: [...(raw.adminIds ?? [])],
        gateway,
        backupNotifiers: archiveBackupNotifiers(client, ctx.translator),
        archiveRepos: buildArchiveRepos,
        writerRepos: buildArchiveWriterRepos,
      });
    },
    async onReady(ctx) {
      // Each shard's first READY arrived before the raw listener was attached.
      for (const [shardId, sessionId] of gateway?.sessions() ?? []) {
        if (sessionId !== undefined) decoder.seed(shardId, sessionId);
        else if (!seedingWarned) {
          // The SDK keeps sessions in private state; a rename must not fail silently.
          seedingWarned = true;
          ctx.logger.warn(
            { shardId },
            'Archive Gateway session seeding unavailable; first session replacement after login may be missed',
          );
        }
      }
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
        const active = worker;
        const events = decoder.decode(packet, shardId, Date.now());
        // Admitted together, so one guild's slow or failed capture never delays another.
        const results = await Promise.allSettled(events.map((event) => active.capture(event)));
        results.forEach((result, index) => {
          if (result.status === 'rejected')
            ctx.logger.error(
              { guildId: events[index]?.guildId, err: result.reason },
              'Archive event capture gap',
            );
        });
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
