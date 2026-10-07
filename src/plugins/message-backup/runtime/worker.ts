import { ArchiveControlService } from '../../../infra/archive/control';
import {
  archiveJobDeletions,
  finalizeArchiveJobDeletion,
  recoverArchiveRunConsumers,
  recoverArchiveOrphanConsumers,
} from '../../../infra/archive/lifecycle';
import { createHash, randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { Routes, type Client, type GuildBasedChannel } from 'discord.js';
import type {
  ArchiveSnapshot,
  ArchiveInboxEntry,
  ArchiveJob,
  ArchivePeriodicRun,
} from '../../../core/archive/types';
import type { ArchiveProgressSnapshot, ArchiveGapReason } from '../../../core/archive/progress';
import { archiveJobProgress, sanitizeArchiveProgress } from '../../../core/archive/progress';
import { ArchivePipelineBudget } from '../flow/pipeline';
import { ArchivePerformanceSampler } from '../../../core/archive/performance';
import { normalizeMessage, mergeSnapshot, emojiKey } from '../../../core/archive/normalize';
import { evaluatePolicy, type ArchivePolicy } from '../../../core/archive/policy';
import { asGuildId } from '../../../core/ids';
import type { Logger } from '../../../core/logger';
import { canReadArchiveSource } from '../../../infra/discord/archive-access';
import type { Translator } from '../../../core/i18n';
import type { GuildRegistry } from '../../../bot/guild-registry';
import type { ConnectionManager, GuildConnection } from '../../../infra/mongo/connection-manager';
import { ArchiveJobNotifier } from './job-notification';
import { ArchiveScheduleStore } from '../../../infra/archive/schedule';
import { ARCHIVE_PROCESS_ID, releaseTerminatedArchiveOwner } from '../../../infra/archive/owner';
import {
  ArchiveStorageMonitor,
  measureStorageRoots,
  resolveArchiveStorageRoots,
} from '../../../infra/archive/storage-usage';
import {
  MongoArchiveRepo,
  type ArchiveMutationInterceptor,
} from '../../../persistence/repositories/archive.repo';
import { ArchiveScheduler } from '../flow/scheduler';
import { ArchiveRestTelemetry } from '../flow/rest-telemetry';
import {
  estimatePeriodicWork,
  updatePeriodicHistory,
  type PeriodicHistory,
} from '../flow/periodic-estimate';
import {
  KnownPhaseEstimator,
  ProgressNotifier,
  ProgressTracker,
  type RemainingEstimate,
} from '../flow/progress';
import type { ArchiveRuntimeConfig } from '../config';
import { BackupLog, NullBackupLog } from '../internal/backup-log';
import { buildBackupLogPath } from '../internal/log-path';
import { ArchiveSerialWriter } from './serial-writer';
import { scanArchiveHistory, type HistoryCheckpoint } from './history';
import type { ArchiveGatewayEvent } from './gateway-event';
import type { RepairBackfillContext, RepairResult } from '../repair/contracts';
import { ArchiveRepairCancellation, ArchiveRepairCancelledError } from '../repair/cancellation';

interface GuildWorker {
  conn: GuildConnection;
  repo: MongoArchiveRepo;
  writer: ArchiveSerialWriter;
  storage: ArchiveStorageMonitor;
  ready: boolean;
  fullRequired: boolean;
  gap: boolean;
  gapVersion: number;
  observationEpoch: number;
  dirty: Map<string, number>;
  generations: Map<string, Set<string>>;
  signal: AbortController;
  progress?: ProgressTracker;
  reactionRates?: number[];
  notifications?: ProgressNotifier<ArchiveProgressSnapshot>;
  heartbeat?: ReturnType<typeof setInterval>;
  progressScope?: { generation: string; jobId?: string; scanId?: string };
  working?: 'job' | 'periodic';
  periodicWork?: Promise<void>;
  jobWork?: Promise<void>;
  periodicAbort?: AbortController;
  heartbeatWork?: Promise<void>;
  progressRoute?: string;
  pipeline?: unknown;
  detailSignatures?: Map<string, string>;
  progressMessage?: {
    edit(options: { content: string; allowedMentions: { parse: never[] } }): Promise<unknown>;
  };
  notifiedAt: number;
  draining?: Promise<void>;
  nextGarbageAt?: number;
  inboxWriter: ArchiveSerialWriter;
  inboxBudget?: { bytes: number; measuredAt: number };
}
interface ArchiveWorkerOptions {
  client: Client;
  registry: GuildRegistry;
  connections: ConnectionManager;
  logger: Logger;
  translator: Translator;
  guildIds: readonly string[];
  config: ArchiveRuntimeConfig;
  policy: ArchivePolicy;
  backupLogEnabled?: boolean;
}

/** One process owns archive writes and consumes durable Discord control jobs. */
export class ArchiveWorker {
  private readonly states = new Map<string, GuildWorker>();
  private readonly initializing = new Map<string, Promise<GuildWorker>>();
  private readonly scheduler: ArchiveScheduler;
  private readonly telemetry = new ArchiveRestTelemetry(Date.now, (wait) => {
    this.scheduler.observeWait(wait);
    for (const state of this.states.values())
      for (const activity of state.progress?.activityDetails() ?? [])
        if (
          (wait.global || activity.sourceId === wait.resourceId) &&
          ['fetching', 'reactions', 'waiting'].includes(activity.step)
        )
          state.progress?.activity(activity.sourceId, {
            step: 'waiting',
            waitSince: activity.waitSince ?? Date.now(),
            retryAt: wait.deadlineAt,
          });
  });
  private readonly pipelineBudget = new ArchivePipelineBudget();
  private readonly captures = new Set<Promise<void>>();
  private readonly admissions = new Map<string, number>();
  private readonly dropped = new Set<string>();
  private readonly sourceObservations = new WeakMap<
    object,
    { watermark: number; gapVersion: number; valid: boolean }
  >();
  private stopped = false;
  private storage: ArchiveStorageMonitor | undefined;
  private readonly performanceSampler = new ArchivePerformanceSampler(1000);
  private readonly durations = {
    ownerRenewalMs: 0,
    checkpointMs: 0,
    shutdownDrainMs: 0,
    inboxOldestAgeMs: 0,
    inboxEvents: 0,
    inboxLatencyMs: 0,
  };
  private readonly policyHash: string;
  public constructor(private readonly options: ArchiveWorkerOptions) {
    this.performanceSampler.start();
    this.policyHash = createHash('sha256').update(JSON.stringify(options.policy)).digest('hex');
    this.scheduler = new ArchiveScheduler({ concurrency: options.config.concurrency });
    if (typeof options.client.rest.on === 'function') this.telemetry.attach(options.client.rest);
  }

  public async initialize(guildId: string): Promise<GuildWorker> {
    const initializing = this.initializing.get(guildId);
    if (initializing !== undefined) return initializing;
    const existing = this.states.get(guildId);
    if (existing !== undefined) return existing;
    const work = this.open(guildId);
    this.initializing.set(guildId, work);
    try {
      return await work;
    } catch (error) {
      const failed = this.states.get(guildId);
      this.states.delete(guildId);
      await failed?.repo.releaseOwner(ARCHIVE_PROCESS_ID).catch((releaseError: unknown) => {
        this.options.logger.warn(
          { guildId, err: releaseError },
          'Failed archive initialization retained ownership',
        );
      });
      throw error;
    } finally {
      this.initializing.delete(guildId);
    }
  }

  private async open(guildId: string): Promise<GuildWorker> {
    if (!this.options.guildIds.includes(guildId) || this.stopped)
      throw new Error('Guild is outside archive scope');
    const conn = await this.options.connections.getConnection(asGuildId(guildId));
    const repo = new MongoArchiveRepo(conn, 'msg-archive');
    if (!(await repo.acquireOwner(ARCHIVE_PROCESS_ID, Date.now()))) {
      if (
        !(await releaseTerminatedArchiveOwner(conn)) ||
        !(await repo.acquireOwner(ARCHIVE_PROCESS_ID, Date.now()))
      ) {
        throw new Error('Archive owner is active or not proven drained');
      }
    }
    const budget = this.options.config.storage;
    const storage = (this.storage ??= new ArchiveStorageMonitor(
      async () =>
        measureStorageRoots(
          await resolveArchiveStorageRoots(
            conn.connection,
            budget.additional_roots,
            budget.mongo_data_root,
          ),
        ),
      budget.budget_bytes,
      budget.background_limit_bytes,
      budget.reserve_bytes,
      30_000,
      (usage) => {
        this.options.logger.warn(
          { usedBytes: usage.usedBytes, availableBytes: usage.availableBytes },
          'Archive project capacity warning',
        );
      },
    ));
    storage.start();
    const state: GuildWorker = {
      conn,
      repo,
      writer: new ArchiveSerialWriter(this.options.config.max_pending_events),
      storage,
      inboxWriter: new ArchiveSerialWriter(this.options.config.max_pending_events),
      ready: false,
      fullRequired: true,
      gap: false,
      gapVersion: 0,
      observationEpoch: 0,
      dirty: new Map(),
      generations: new Map(),
      signal: new AbortController(),
      notifiedAt: 0,
    };
    this.states.set(guildId, state);
    // Collection creation/index maintenance is explicit and occurs only after
    // ownership. Legacy Message duplicates must leave capture available for repair.
    await storage.withReservation(1_048_576, false, async () => {
      await conn.connection
        .collection('archive_progress_details')
        .createIndex({ guildId: 1, scopeId: 1, sourceId: 1 }, { unique: true });
      for (const [name, model] of Object.entries(conn.models)) {
        if (name.startsWith('Archive')) {
          await model.createCollection();
          await model.createIndexes();
        }
      }
      try {
        await conn.models.Message.createCollection();
        const indexes = await conn.models.Message.collection.indexes();
        const names = new Set(indexes.map((index) => index.name));
        if (
          ['messageId_1', 'timestamp_1', 'channelId_1_timestamp_1'].some(
            (name) => !names.has(name),
          ) &&
          (await conn.models.Message.exists({}))
        ) {
          throw new Error('Existing messages require reviewed index capacity preflight');
        }
        await conn.models.Message.createIndexes();
        await conn.models.Fetch.createCollection();
        await conn.models.Fetch.createIndexes();
        state.ready = true;
      } catch (error) {
        this.options.logger.error(
          { guildId, err: error },
          'Archive structural maintenance required; capture-only mode',
        );
      }
    });
    // Never reclaim a running job simply because its lease timer expired. The
    // prior process was proven terminated and drained before this recovery point.
    await conn.models.ArchiveInbox.updateMany(
      { state: 'processing' },
      { $set: { state: 'pending' }, $unset: { claimToken: 1, leaseUntil: 1 } },
    ).exec();
    await conn.models.ArchiveJob.updateMany(
      { status: 'running' },
      {
        $set: {
          status: 'partial',
          finishedAt: Date.now(),
          'result.status': 'partial',
          'result.issues': ['Worker stopped; resume using the recorded run ID'],
        },
      },
    ).exec();
    await recoverArchiveOrphanConsumers(conn.connection, guildId);
    await recoverArchiveRunConsumers(conn.connection, guildId);
    await this.recoverControlDeletions(guildId, state);
    return state;
  }

  public async capture(event: ArchiveGatewayEvent): Promise<void> {
    if (this.stopped || !this.options.guildIds.includes(event.guildId)) return;
    const active = this.admissions.get(event.guildId) ?? 0;
    if (active >= this.options.config.max_pending_events) {
      this.dropped.add(event.guildId);
      const state = this.states.get(event.guildId);
      if (state !== undefined) {
        state.gap = true;
        state.gapVersion += 1;
        state.fullRequired = true;
      }
      throw new Error('Archive capture queue overflow; history reconciliation required');
    }
    this.admissions.set(event.guildId, active + 1);
    const pending = this.captureEvent(event);
    this.captures.add(pending);
    try {
      await pending;
    } finally {
      this.admissions.set(event.guildId, (this.admissions.get(event.guildId) ?? 1) - 1);
      this.captures.delete(pending);
    }
  }

  private async captureEvent(event: ArchiveGatewayEvent): Promise<void> {
    const state = await this.initialize(event.guildId);
    if (this.dropped.delete(event.guildId)) {
      state.gap = true;
      state.gapVersion += 1;
      state.fullRequired = true;
    }
    if (event.messageId !== undefined) {
      const version = ++state.observationEpoch;
      state.dirty.delete(event.messageId);
      state.dirty.set(event.messageId, version);
      // An evicted watermark invalidates in-flight readers through the epoch.
      if (state.dirty.size > this.options.config.max_pending_events * 10) {
        const oldest = state.dirty.keys().next().value;
        if (oldest !== undefined) state.dirty.delete(oldest);
        state.gapVersion += 1;
      }
    }
    try {
      await this.persistEvent(state, event);
    } catch (error) {
      state.gap = true;
      state.gapVersion += 1;
      state.fullRequired = true;
      throw error;
    }
  }

  private async persistEvent(
    state: GuildWorker,
    event: ArchiveGatewayEvent,
    initialPayload: Record<string, unknown> = {},
  ): Promise<void> {
    let payload = initialPayload;
    if (event.raw !== undefined) {
      payload = normalizeMessage(
        { ...event.raw },
        {
          guildId: event.guildId,
          channelId: event.channelId,
          observedAt: event.observedAt,
          source: 'gateway',
          channelName:
            this.options.client.channels.cache.get(event.channelId)?.isDMBased() === false
              ? ((this.options.client.channels.cache.get(event.channelId) as { name?: string })
                  .name ?? '')
              : '',
        },
      ) as unknown as Record<string, unknown>;
      payload.observationId = event.eventId;
      const excludedSource =
        payload.authorKind === 'webhook'
          ? this.options.policy.webhooks.length === 0
          : payload.authorKind === 'bot' && this.options.policy.bots.length === 0;
      if (excludedSource) {
        // Empty source lists are conclusive without content. Retain identity
        // evidence for legacy cleanup without filling the durable inbox with it.
        const presence = payload.presence as Record<string, string>;
        for (const field of [
          'content',
          'attachments',
          'reactions',
          'stickers',
          'embeds',
          'mentions',
          'reference',
          'thread',
          'poll',
          'components',
          'snapshots',
        ]) {
          delete payload[field];
          presence[field] = 'excluded';
        }
      }
    }
    const bytes = Buffer.byteLength(JSON.stringify(payload)) * 3 + 4096;
    // Serialize admission, while reducing events independently. Cache a
    // conservative upper bound so each Gateway event does not scan the inbox.
    await state.inboxWriter.run(async () => {
      if (state.inboxBudget === undefined || Date.now() - state.inboxBudget.measuredAt >= 30_000) {
        const stats = await state.conn.models.ArchiveInbox.collection
          .aggregate<{
            bytes: number;
          }>([{ $group: { _id: null, bytes: { $sum: { $bsonSize: '$$ROOT' } } } }])
          .next();
        state.inboxBudget = { bytes: stats?.bytes ?? 0, measuredAt: Date.now() };
      }
      if (state.inboxBudget.bytes + bytes > this.options.config.max_inbox_bytes)
        throw new Error('Archive inbox capacity exhausted');
      await state.storage.withReservation(bytes, false, () =>
        state.repo.enqueue({
          eventId: event.eventId,
          kind: event.kind,
          channelId: event.channelId,
          ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
          payload,
          observedAt: event.observedAt,
        }),
      );
      state.inboxBudget.bytes += bytes;
    });
  }

  public async markGap(reason: string): Promise<void> {
    for (const guildId of this.options.guildIds) {
      const state = await this.initialize(guildId);
      state.fullRequired = true;
      state.gap = true;
      state.gapVersion += 1;
      await this.persistEvent(
        state,
        {
          eventId: `gap:${randomUUID()}`,
          guildId,
          channelId: '',
          kind: 'gap',
          observedAt: Date.now(),
        },
        { reason },
      );
    }
  }

  private async mutate<T>(
    state: GuildWorker,
    operation: () => Promise<T>,
    interceptor?: ArchiveMutationInterceptor,
  ): Promise<T> {
    return state.writer.run(async () => {
      state.repo.setMutationInterceptor(interceptor);
      try {
        return await state.storage.withReservation(4096, false, operation);
      } finally {
        state.repo.setMutationInterceptor(undefined);
      }
    });
  }

  public async drainInbox(guildId: string, limit = 100): Promise<void> {
    const state = await this.initialize(guildId);
    if (!state.ready) return;
    if (state.draining !== undefined) return state.draining;
    state.draining = this.reduceInbox(state, guildId, limit).finally(() => {
      state.draining = undefined;
    });
    return state.draining;
  }

  private async reduceInbox(state: GuildWorker, guildId: string, limit: number): Promise<void> {
    let processed = 0;
    while (processed < limit && !this.stopped && state.ready) {
      const claimToken = randomUUID();
      const entries = await state.repo.claimInboxBatch(
        claimToken,
        Date.now(),
        60000,
        Math.min(16, limit - processed),
      );
      if (entries.length === 0) break;
      const outstanding = new Set(entries.map((entry) => entry.eventId));
      const latest = new Map<string, string>();
      for (const entry of entries)
        if (entry.messageId !== undefined) {
          if (entry.kind === 'delete') latest.delete(entry.messageId);
          else if (entry.kind === 'snapshot' || entry.kind === 'reaction')
            latest.set(entry.messageId, entry.eventId);
        }
      let renewing: Promise<void> | undefined;
      let leaseFailure: unknown;
      const timer = setInterval(() => {
        if (renewing !== undefined) return;
        renewing = state.repo
          .renewInboxBatch(claimToken, [...outstanding], Date.now(), 60000)
          .catch((error: unknown) => {
            leaseFailure = error;
          })
          .finally(() => {
            renewing = undefined;
          });
      }, 20000);
      timer.unref();
      try {
        for (const entry of entries) {
          if (this.stopped || !state.ready) break;
          if (leaseFailure !== undefined) throw leaseFailure;
          try {
            await this.applyEvent(
              state,
              entry,
              entry.messageId === undefined || latest.get(entry.messageId) === entry.eventId,
            );
            if (leaseFailure !== undefined) throw leaseFailure;
            await state.repo.ackInbox(entry.eventId, claimToken);
            this.durations.inboxEvents += 1;
            this.durations.inboxLatencyMs += Math.max(0, Date.now() - entry.observedAt);
          } catch (error) {
            await state.repo.deferInbox(
              entry.eventId,
              claimToken,
              String(error),
              Date.now() + 300000,
            );
            this.options.logger.warn(
              { guildId, eventId: entry.eventId, err: error },
              'Archive event reconciliation deferred',
            );
          }
          outstanding.delete(entry.eventId);
          processed += 1;
        }
      } finally {
        clearInterval(timer);
        await renewing;
        for (const eventId of outstanding) await state.repo.releaseInbox(eventId, claimToken);
      }
    }
  }

  private async applyEvent(
    state: GuildWorker,
    entry: ArchiveInboxEntry,
    reconcile = true,
  ): Promise<void> {
    if (entry.kind === 'gap') {
      state.fullRequired = true;
      state.gap = true;
      state.gapVersion += 1;
      return;
    }
    if (entry.messageId === undefined || entry.channelId === undefined)
      throw new Error('Invalid archive inbox identity');
    if (entry.kind === 'delete') {
      await this.mutate(state, () =>
        state.repo.tombstone(entry.messageId!, entry.channelId!, entry.observedAt),
      );
      return;
    }
    if (entry.kind === 'snapshot') {
      const snapshot = entry.payload as unknown as ArchiveSnapshot;
      if (!(await this.saveSnapshot(state, snapshot))) return;
    }
    await this.mutate(state, () =>
      state.repo.markReactionsStale(entry.messageId!, entry.observedAt),
    );
    if (!reconcile) return;
    // Reconcile missing partial fields and reaction changes via the same REST
    // manager. A 403 remains pending/incomplete; only an actual 10008 is deletion.
    try {
      const raw = await this.scheduler.run(
        `live:${entry.channelId}:${entry.messageId}`,
        'live',
        () =>
          this.readObserved(state, () =>
            this.options.client.rest.get(
              Routes.channelMessage(entry.channelId!, entry.messageId!),
              {
                signal: state.signal.signal,
              },
            ),
          ),
        {
          signal: state.signal.signal,
          guildId: String(state.conn.guildId),
          resourceId: entry.channelId,
        },
      );
      await this.ingest(state, raw as Record<string, unknown>, undefined, 'history');
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 10008) {
        await this.mutate(state, () =>
          state.repo.tombstone(entry.messageId!, entry.channelId!, Date.now()),
        );
      } else throw error;
    }
  }

  private async saveSnapshot(
    state: GuildWorker,
    snapshot: ArchiveSnapshot,
    interceptor?: ArchiveMutationInterceptor,
  ): Promise<boolean> {
    return this.mutate(
      state,
      async () => {
        const previous = await state.conn.models.Message.collection.findOne({
          messageId: snapshot.messageId,
        });
        const decision = evaluatePolicy(
          mergeSnapshot((previous as Partial<ArchiveSnapshot>) ?? {}, snapshot),
          this.options.policy,
        );
        if (!decision.admitted) {
          if (previous !== null && !decision.unresolved) {
            await state.storage.withReservation(4096, snapshot.source !== 'gateway', () =>
              state.repo.recordSourceEvidence(
                snapshot.messageId,
                snapshot,
                {
                  policyHash: this.policyHash,
                  admitted: false,
                  reason: decision.reason,
                  observedAt: snapshot.observedAt,
                },
                { interceptor },
              ),
            );
          }
          return false;
        }
        snapshot.policy = {
          version: this.options.policy.version,
          reason: decision.reason,
          ...(decision.ruleId === undefined ? {} : { ruleId: decision.ruleId }),
        };
        await state.storage.withReservation(
          Buffer.byteLength(JSON.stringify(snapshot)) * 4 + 4096,
          snapshot.source !== 'gateway',
          () => state.repo.persistSnapshot(snapshot, { observed: previous, interceptor }),
        );
        return previous?.deletion === undefined;
      },
      interceptor,
    );
  }

  private async readObserved<T>(state: GuildWorker, operation: () => Promise<T>): Promise<T> {
    const epoch = state.observationEpoch;
    const gapVersion = state.gapVersion;
    const result = await operation();
    for (const raw of Array.isArray(result) ? result : [result])
      if (typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'string') {
        const watermark = state.dirty.get(raw.id) ?? 0;
        this.sourceObservations.set(raw, {
          watermark,
          gapVersion,
          valid: watermark <= epoch && state.gapVersion === gapVersion,
        });
      }
    return result;
  }

  private async ingest(
    state: GuildWorker,
    raw: Record<string, unknown>,
    channel: GuildBasedChannel | undefined,
    source: 'history' | 'repair',
    interceptor?: ArchiveMutationInterceptor,
    signal = state.signal.signal,
    onReactionProgress?: (estimate: RemainingEstimate | undefined) => Promise<void>,
  ): Promise<boolean> {
    const snapshot = normalizeMessage(raw, {
      guildId: String(state.conn.guildId),
      observedAt: Date.now(),
      source,
      ...(channel === undefined
        ? {}
        : {
            channelId: channel.id,
            channelName: channel.name,
            ...(channel.parentId === null ? {} : { parentId: channel.parentId }),
          }),
    });
    if (!(await this.saveSnapshot(state, snapshot, interceptor))) return false;
    await this.enrichReactions(state, raw, snapshot, interceptor, signal, onReactionProgress);
    return true;
  }

  private async ingestPage(
    state: GuildWorker,
    raws: readonly Record<string, unknown>[],
    channel: GuildBasedChannel,
    source: 'history' | 'repair',
    interceptor: ArchiveMutationInterceptor | undefined,
    signal: AbortSignal,
    checkpoint: () => Promise<void>,
  ): Promise<{
    admitted: boolean[];
    counts: Pick<
      ArchiveProgressSnapshot['messages'],
      'inserted' | 'updated' | 'unchanged' | 'durable'
    >;
    reactions: number;
  }> {
    const normalizeStarted = performance.now();
    const snapshots = raws.map((raw) =>
      normalizeMessage(raw, {
        guildId: String(state.conn.guildId),
        channelId: channel.id,
        channelName: channel.name,
        observedAt: Date.now(),
        source,
        ...(channel.parentId === null ? {} : { parentId: channel.parentId }),
      }),
    );
    this.pipelineBudget.record('normalize', performance.now() - normalizeStarted);
    const counts = { inserted: 0, updated: 0, unchanged: 0, durable: 0 };
    const writeStarted = performance.now();
    const admitted: boolean[] = [];
    for (let offset = 0; offset < snapshots.length; offset += 25) {
      await checkpoint();
      const batch = snapshots.slice(offset, offset + 25);
      state.progress?.activity(channel.id, {
        step: 'writing',
        pageProcessed: admitted.length,
        pageTotal: raws.length,
        provisional: true,
      });
      await this.mutate(
        state,
        async () => {
          let previous: ReadonlyMap<string, Record<string, unknown>> | undefined;
          try {
            previous = await state.repo.loadSnapshotBatch(batch.map((item) => item.messageId));
          } catch (error) {
            if (!(error instanceof RangeError)) throw error;
          }
          const seen = new Set<string>();
          for (const snapshot of batch) {
            if (signal.aborted) throw new Error('Archive page cancelled before write');
            const observed =
              previous === undefined || seen.has(snapshot.messageId)
                ? await state.conn.models.Message.collection.findOne({
                    messageId: snapshot.messageId,
                  })
                : (previous.get(snapshot.messageId) ?? null);
            seen.add(snapshot.messageId);
            const decision = evaluatePolicy(
              mergeSnapshot((observed as Partial<ArchiveSnapshot>) ?? {}, snapshot),
              this.options.policy,
            );
            if (!decision.admitted) {
              if (observed !== null && !decision.unresolved)
                await state.storage.withReservation(4096, true, () =>
                  state.repo.recordSourceEvidence(
                    snapshot.messageId,
                    snapshot,
                    {
                      policyHash: this.policyHash,
                      admitted: false,
                      reason: decision.reason,
                      observedAt: snapshot.observedAt,
                    },
                    { interceptor },
                  ),
                );
              admitted.push(false);
              continue;
            }
            snapshot.policy = {
              version: this.options.policy.version,
              reason: decision.reason,
              ...(decision.ruleId === undefined ? {} : { ruleId: decision.ruleId }),
            };
            const outcome = await state.storage.withReservation(
              Buffer.byteLength(JSON.stringify(snapshot)) * 4 + 4096,
              true,
              () => state.repo.persistSnapshot(snapshot, { observed, interceptor }),
            );
            admitted.push(observed?.['deletion'] === undefined);
            if (observed?.['deletion'] === undefined) {
              counts.durable += 1;
              if (outcome === 'inserted' || outcome === 'updated' || outcome === 'unchanged')
                counts[outcome] += 1;
              else counts.unchanged += 1;
            }
            state.progress?.activity(channel.id, {
              step: 'writing',
              pageProcessed: admitted.length,
              pageTotal: raws.length,
              provisional: true,
            });
          }
        },
        interceptor,
      );
      if (offset + 25 < snapshots.length && state.ready)
        await this.drainInbox(String(state.conn.guildId), 16);
    }
    this.pipelineBudget.record('write', performance.now() - writeStarted);
    let reactions = 0;
    for (let index = 0; index < raws.length; index += 1) {
      if (!admitted[index]) continue;
      await checkpoint();
      if (signal.aborted) throw new Error('Archive page cancelled before reactions');
      const raw = raws[index]!;
      const snapshot = snapshots[index]!;
      const required = Array.isArray(raw.reactions) && raw.reactions.length > 0;
      if (required)
        state.progress?.activity(channel.id, {
          step: 'reactions',
          pageProcessed: index,
          pageTotal: raws.length,
          provisional: true,
        });
      const started = performance.now();
      await this.enrichReactions(state, raw, snapshot, interceptor, signal, undefined, checkpoint);
      this.pipelineBudget.record('reactions', performance.now() - started);
      if (required) reactions += 1;
      state.progress?.activity(channel.id, {
        step: 'processing',
        pageProcessed: index + 1,
        pageTotal: raws.length,
        provisional: true,
      });
    }
    return { admitted, counts, reactions };
  }

  private async enrichReactions(
    state: GuildWorker,
    raw: Record<string, unknown>,
    snapshot: ArchiveSnapshot,
    interceptor?: ArchiveMutationInterceptor,
    signal = state.signal.signal,
    onReactionProgress?: (estimate: RemainingEstimate | undefined) => Promise<void>,
    checkpoint?: () => Promise<void>,
  ): Promise<void> {
    const { fetchReactionMemberships } = await import('../flow/reactions');
    const generation = randomUUID();
    const active = state.generations.get(snapshot.messageId) ?? new Set<string>();
    active.add(generation);
    state.generations.set(snapshot.messageId, active);
    try {
      await this.mutate(
        state,
        () => state.repo.markReactionsStale(snapshot.messageId, Date.now()),
        interceptor,
      );
      let observation = this.sourceObservations.get(raw);
      if (
        observation === undefined &&
        (raw.reactions === undefined ||
          (Array.isArray(raw.reactions) && raw.reactions.length === 0))
      ) {
        const refreshed = await this.readObserved(state, () =>
          this.scheduler.run(
            `reaction-evidence:${snapshot.channelId}:${snapshot.messageId}`,
            'enrichment',
            () =>
              this.options.client.rest.get(
                Routes.channelMessage(snapshot.channelId, snapshot.messageId),
                { signal },
              ),
            { signal, guildId: String(state.conn.guildId), resourceId: snapshot.channelId },
          ),
        );
        if (
          typeof refreshed !== 'object' ||
          refreshed === null ||
          !('id' in refreshed) ||
          ('reactions' in refreshed &&
            refreshed.reactions !== undefined &&
            !Array.isArray(refreshed.reactions))
        )
          throw new Error('Reaction source evidence unavailable');
        raw = refreshed as Record<string, unknown>;
        observation = this.sourceObservations.get(raw);
      }
      if (observation?.valid === false) throw new Error('Reaction source changed during fetch');
      const watermark = observation?.watermark ?? state.dirty.get(snapshot.messageId) ?? 0;
      const gapVersion = observation?.gapVersion ?? state.gapVersion;
      const reactions = Array.isArray(raw.reactions)
        ? (raw.reactions as {
            emoji: { id?: string; name?: string };
            count?: number;
            count_details?: { normal: number; burst: number };
          }[])
        : [];
      const expected = reactions.every(
        (reaction) => typeof reaction.count === 'number' || reaction.count_details !== undefined,
      )
        ? reactions.reduce(
            (sum, reaction) =>
              sum +
              (reaction.count_details === undefined
                ? (reaction.count ?? 0)
                : reaction.count_details.normal + reaction.count_details.burst),
            0,
          )
        : undefined;
      const estimator = new KnownPhaseEstimator(
        'reactions',
        expected,
        Date.now,
        state.reactionRates,
      );
      await onReactionProgress?.(estimator.snapshot());
      const streams = reactions.map((reaction) => ({
        emoji: reaction.emoji.id
          ? `${reaction.emoji.name ?? '_'}:${reaction.emoji.id}`
          : (reaction.emoji.name ?? ''),
        kinds: ['normal', 'burst'] as ('normal' | 'burst')[],
        ...(observation?.valid === true &&
        (state.dirty.get(snapshot.messageId) ?? 0) === watermark &&
        state.gapVersion === gapVersion
          ? {
              emptyKinds: (['normal', 'burst'] as const).filter(
                (kind) => reaction.count_details?.[kind] === 0 || reaction.count === 0,
              ),
            }
          : {}),
      }));
      const canonicalKeys = new Map(
        reactions.map((reaction, index) => [streams[index]!.emoji, emojiKey(reaction.emoji)]),
      );
      const chunks = new Map<string, number>();
      let reactionUsers = 0;
      let reactionPages = 0;
      const reportReactionActivity = (): void => {
        state.progress?.activity(snapshot.channelId, {
          step: 'reactions',
          reactionUsers,
          reactionPages,
          provisional: true,
        });
      };
      if (streams.length > 0) reportReactionActivity();
      const result = await fetchReactionMemberships({
        rest: this.options.client.rest,
        channelId: snapshot.channelId,
        messageId: snapshot.messageId,
        streams,
        concurrency: Math.min(2, this.options.config.concurrency),
        pipelineBudget: this.pipelineBudget,
        signal,
        dirtyVersion: () =>
          state.gapVersion === gapVersion ? (state.dirty.get(snapshot.messageId) ?? 0) : -1,
        request: async (key, operation) => {
          await checkpoint?.();
          return this.scheduler.run(
            key,
            'enrichment',
            () => {
              reportReactionActivity();
              return operation();
            },
            {
              signal,
              guildId: String(state.conn.guildId),
              resourceId: snapshot.channelId,
            },
          );
        },
        stage: async ({ emoji, kind, page, userIds }) => {
          await checkpoint?.();
          if (signal.aborted) throw new Error('Archive reaction refresh cancelled');
          const type = kind === 'normal' ? 0 : 1;
          await state.storage.withReservation(userIds.length * 100 + 4096, true, () =>
            this.mutate(
              state,
              () =>
                state.repo.stageReaction(
                  snapshot.messageId,
                  canonicalKeys.get(emoji)!,
                  type,
                  generation,
                  page,
                  userIds,
                  Date.now(),
                ),
              interceptor,
            ),
          );
          chunks.set(`${emoji}:${type}`, page + 1);
          reactionUsers += userIds.length;
          reactionPages += 1;
          reportReactionActivity();
          estimator.commit(userIds.length);
          await onReactionProgress?.(estimator.snapshot());
        },
      });
      state.reactionRates = estimator.speedSamples();
      if (signal.aborted) throw new Error('Archive reaction refresh cancelled');
      if (
        result.some((stream) => !stream.complete) ||
        (state.dirty.get(snapshot.messageId) ?? 0) !== watermark ||
        state.gapVersion !== gapVersion
      ) {
        throw new Error('Reaction membership changed or remains incomplete');
      }
      await this.mutate(
        state,
        async () => {
          if (
            (state.dirty.get(snapshot.messageId) ?? 0) !== watermark ||
            state.gapVersion !== gapVersion
          )
            throw new Error('Reaction membership invalidated before publication');
          for (const stream of result) {
            const type = stream.kind === 'normal' ? 0 : 1;
            await state.repo.publishReaction(
              snapshot.messageId,
              canonicalKeys.get(stream.emoji)!,
              type,
              generation,
              chunks.get(`${stream.emoji}:${type}`) ?? 0,
              Date.now(),
            );
          }
          await state.repo.finalizeReactionRefresh(
            snapshot.messageId,
            generation,
            result.map(
              (stream) => `${canonicalKeys.get(stream.emoji)!}:${stream.kind === 'normal' ? 0 : 1}`,
            ),
            Date.now(),
          );
        },
        interceptor,
      );
    } finally {
      try {
        await onReactionProgress?.(undefined);
      } finally {
        active.delete(generation);
        if (active.size === 0) state.generations.delete(snapshot.messageId);
      }
    }
  }

  private readonly recoveredSchedules = new Set<string>();

  public async scheduledPeriodic(guildId: string, intervalMs: number): Promise<void> {
    const state = await this.initialize(guildId);
    const schedule = new ArchiveScheduleStore(state.conn.connection, intervalMs);
    if (!this.recoveredSchedules.has(guildId)) {
      await schedule.recover();
      this.recoveredSchedules.add(guildId);
    }
    if (!state.ready || state.working !== undefined) return;
    const started = await schedule.start();
    if (started === null) return;
    let checkedAt = 0;
    let checking: Promise<boolean> | undefined;
    const shouldContinue = (): Promise<boolean> => {
      if (checking === undefined || Date.now() - checkedAt >= 1000) {
        checkedAt = Date.now();
        checking = schedule
          .read()
          .then((current) => current.enabled && current.pauseVersion === started.pauseVersion);
      }
      return checking;
    };
    const work = this.startPeriodic(state, guildId, shouldContinue);
    try {
      await work;
    } finally {
      // A control job may acquire the worker while the schedule claim is in flight.
      // Releasing an unused claim must preserve its due time for the next poll.
      await (work === undefined ? schedule.recover() : schedule.finish(started.revision)).catch(
        (error: unknown) => {
          // Retry recovery on the next serialized pass if completion could not be saved.
          this.recoveredSchedules.delete(guildId);
          this.options.logger.error({ guildId, err: error }, 'Archive schedule completion failed');
        },
      );
    }
  }

  public async periodic(guildId: string, shouldContinue?: () => Promise<boolean>): Promise<void> {
    const state = await this.initialize(guildId);
    await this.startPeriodic(state, guildId, shouldContinue);
  }

  private startPeriodic(
    state: GuildWorker,
    guildId: string,
    shouldContinue?: () => Promise<boolean>,
  ): Promise<void> | undefined {
    if (state.working !== undefined) return undefined;
    state.working = 'periodic';
    state.periodicAbort = new AbortController();
    const work = (async () => {
      try {
        await this.runPeriodic(state, guildId, shouldContinue);
      } finally {
        await this.closeProgressPublication(state);
        state.periodicWork = undefined;
        state.periodicAbort = undefined;
        state.working = undefined;
      }
    })();
    state.periodicWork = work;
    return work;
  }

  private async runPeriodic(
    state: GuildWorker,
    guildId: string,
    shouldContinue?: () => Promise<boolean>,
  ): Promise<void> {
    if (!state.ready) return;
    await this.drainInbox(guildId);
    const runs = state.conn.connection.collection<{
      _id: string;
      runId: string;
      cutoff: number;
      full: boolean;
      status: string;
      result?: unknown;
      progress?: ArchiveProgressSnapshot;
      notification?: ArchiveJob['notification'];
    }>('archive_periodic_runs');
    const previous = await runs.findOne({ _id: 'current' });
    // The run boundary survives process restarts; channel checkpoints are useful
    // only when retries reuse their original identity and creation cutoff.
    const run =
      previous !== null && previous.status !== 'complete'
        ? previous
        : {
            _id: 'current',
            runId: `periodic:${randomUUID()}`,
            cutoff: Date.now(),
            full: state.fullRequired,
            status: 'running',
          };
    const initialProgress = new ProgressTracker({
      cutoff: new Date(run.cutoff),
      startedAt: run.cutoff,
      work: 'periodic',
      scanId: run.runId,
    }).snapshot();
    await runs.replaceOne(
      { _id: 'current' },
      { ...run, status: 'running', progress: initialProgress },
      { upsert: true },
    );
    try {
      const result = await this.scan(
        state,
        run.runId,
        run.cutoff,
        run.full,
        undefined,
        shouldContinue,
      );
      await runs.updateOne(
        { _id: 'current', runId: run.runId },
        { $set: { status: result.status, result, progress: state.progress?.snapshot() } },
      );
      await this.closeProgressPublication(state, true);
      // A resumed pass may have committed channels before a restart. Revisit
      // them in a fresh reconciliation rather than losing downtime edits.
      if (previous !== null && previous.status !== 'complete') state.fullRequired = true;
    } catch (error) {
      state.progress?.gap({ reason: this.gapReason(String(error)) });
      state.progress?.finish('partial');
      await runs.updateOne(
        { _id: 'current', runId: run.runId },
        {
          $set: {
            status: 'partial',
            result: { issues: [String(error)] },
            progress: state.progress?.snapshot(),
          },
        },
      );
      await this.closeProgressPublication(state, true);
      throw error;
    }
  }

  private gapReason(reason: string): ArchiveGapReason {
    return /permission|forbidden|access|denied|403/i.test(reason)
      ? 'permission'
      : /capacity|storage|budget/i.test(reason)
        ? 'capacity'
        : /conflict|changed/i.test(reason)
          ? 'conflict'
          : /thread|discovery|inventory|gap/i.test(reason)
            ? 'discovery'
            : 'other';
  }

  private async scan(
    state: GuildWorker,
    runId: string,
    cutoff: number,
    full: boolean,
    repair?: RepairBackfillContext,
    shouldContinue?: () => Promise<boolean>,
  ): Promise<RepairResult> {
    const transcript = this.options.backupLogEnabled
      ? new BackupLog(buildBackupLogPath(String(state.conn.guildId), new Date()))
      : new NullBackupLog();
    transcript.writeln(`Archive run ${runId}; cutoff ${new Date(cutoff).toISOString()}`);
    try {
      const result = await this.scanRun(state, runId, cutoff, full, repair, shouldContinue);
      transcript.writeln(JSON.stringify(result));
      return result;
    } finally {
      transcript.close();
    }
  }

  private async scanRun(
    state: GuildWorker,
    runId: string,
    cutoff: number,
    full: boolean,
    repair?: RepairBackfillContext,
    shouldContinue?: () => Promise<boolean>,
  ): Promise<RepairResult> {
    const guildId = String(state.conn.guildId);
    const cancellation = new AbortController();
    const capacityPause = new AbortController();
    const signal = AbortSignal.any([
      ...(repair === undefined && state.periodicAbort !== undefined
        ? [state.periodicAbort.signal]
        : []),
      state.signal.signal,
      cancellation.signal,
      capacityPause.signal,
    ]);
    let pauseReason: string | undefined;
    const checkSchedule = async (): Promise<void> => {
      if (shouldContinue !== undefined && !(await shouldContinue())) {
        pauseReason = 'Periodic archive disabled';
        capacityPause.abort();
        throw new Error(pauseReason);
      }
    };
    const repairCancellation =
      repair === undefined
        ? undefined
        : new ArchiveRepairCancellation(
            repair.jobId,
            async (jobId) => (await state.repo.getJob(jobId))?.cancelRequested === true,
            signal,
          );
    const checkBoundary = async (): Promise<void> => {
      await checkSchedule();
      try {
        await repairCancellation?.checkpoint();
      } catch (error) {
        if (error instanceof ArchiveRepairCancelledError) cancellation.abort();
        throw error;
      }
      if (signal.aborted) throw new Error('Archive scan stopped');
    };
    const progress =
      repair === undefined
        ? new ProgressTracker({
            cutoff: new Date(cutoff),
            startedAt: cutoff,
            work: 'periodic',
            scanId: runId,
          })
        : (state.progress ??
          new ProgressTracker({
            cutoff: new Date(cutoff),
            work: 'apply',
            jobId: repair.jobId,
            runId,
          }));
    state.progress = progress;
    progress.setPhase('discovery');
    await this.notify(guildId, state, repair?.jobId, true);
    const gapVersion = state.gapVersion;
    const guild = await this.options.client.guilds.fetch(guildId);
    const channels = new Map(
      (await state.repo.listChannels()).map((channel) => [channel.channelId, channel]),
    );
    const knownChannelIds = new Set([...channels.keys()].filter((id) => !id.startsWith('guild:')));
    for (const value of await state.conn.models.Fetch.distinct('channelID').exec())
      if (typeof value === 'string') knownChannelIds.add(value);
    for (const value of await state.conn.models.Message.distinct('channelId').exec())
      if (typeof value === 'string') knownChannelIds.add(value);
    for (const channel of channels.values())
      if (channel.access === 'deleted') knownChannelIds.delete(channel.channelId);
    const interceptor: ArchiveMutationInterceptor | undefined =
      repair === undefined
        ? undefined
        : (collection, before, after, reason) =>
            repair.applyMutation(
              collection,
              before as Parameters<RepairBackfillContext['applyMutation']>[1],
              after as Parameters<RepairBackfillContext['applyMutation']>[2],
              reason,
            );
    const priors = new Map<string, PeriodicHistory>();
    const pageResults = new Map<string, Awaited<ReturnType<ArchiveWorker['ingestPage']>>>();
    const priorCutoffs = new Map<string, number>();
    const discovered = new Set<string>();
    for (const channel of channels.values()) {
      const checkpoint = channel.checkpoint as unknown as HistoryCheckpoint | undefined;
      if (checkpoint !== undefined) priorCutoffs.set(channel.channelId, checkpoint.cutoff);
      if (checkpoint?.estimatePrevious !== undefined)
        priors.set(channel.channelId, checkpoint.estimatePrevious);
      if (checkpoint?.runId === runId && checkpoint.scanned !== undefined) {
        progress.observe('history', checkpoint.scanned, checkpoint.admitted ?? 0);
        progress.commit(
          'history',
          checkpoint.scanned,
          channel.channelId,
          checkpoint.pageSequence ?? 0,
        );
        const statistics = (
          checkpoint as HistoryCheckpoint & {
            statistics?: {
              messages: ArchiveProgressSnapshot['messages'];
              reactions: number;
              countQuality?: 'exact' | 'lower-bound';
            };
          }
        ).statistics;
        if (checkpoint.version === 2 && statistics !== undefined) {
          progress.messageCounts(statistics.messages);
          if (statistics.countQuality === 'lower-bound') progress.markLegacyCounts();
        } else if (checkpoint.version !== 2 || checkpoint.scanned > 0) progress.markLegacyCounts();
        progress.reactionDiscovered(statistics?.reactions ?? 0);
        progress.reactionCompleted(statistics?.reactions ?? 0);
      }
    }
    // Backfill reuses acknowledged manifest progress. Preserve its totals;
    // unknown scan scope is finalized only after the discovery sweep completes.
    const result = await scanArchiveHistory(guild, this.options.client, this.options.logger, {
      runId,
      cutoff,
      full,
      overlapMinutes: this.options.config.overlap_minutes,
      concurrency: this.options.config.concurrency,
      signal,
      failed: (reason) => {
        if (
          reason.includes('storage headroom exhausted') ||
          reason.includes('capacity is unknown')
        ) {
          pauseReason = reason;
          progress.pause(reason);
          capacityPause.abort();
        }
      },
      phase: (phase) => {
        progress.setPhase(phase);
        void this.notify(guildId, state, repair?.jobId, true);
      },
      pipelineBudget: this.pipelineBudget,
      onPipeline: (snapshot) => {
        state.pipeline = snapshot;
      },
      fetched: (_channelId, count) => progress.messageCounts({ fetched: count }),
      onActivity: (channelId, activity) =>
        progress.activity(
          channelId,
          activity === undefined
            ? undefined
            : {
                ...activity,
                name: channels.get(channelId)?.name ?? channelId,
                direction: 'before',
              },
        ),
      completed: (channelId) => progress.completeSource(channelId),
      knownChannelIds: [...knownChannelIds],
      inventory: async (locations, gaps, readableIds) => {
        for (const gap of gaps)
          progress.gap({
            sourceId: gap.channelId,
            name: locations.find((location) => location.id === gap.channelId)?.name,
            reason: this.gapReason(gap.reason),
          });
        const readable = new Set(readableIds);
        for (const location of locations) {
          const previous = channels.get(location.id);
          const reasons = gaps
            .filter((gap) => gap.channelId === location.id || gap.channelId === undefined)
            .map((gap) => `${gap.pass}:${gap.reason}`);
          const denied = reasons.some(
            (reason) => reason.includes('missing-') || reason.includes('403'),
          );
          const record = {
            ...previous,
            channelId: location.id,
            name: location.name ?? previous?.name ?? '',
            type: location.type,
            observedAt: Date.now(),
            access: readable.has(location.id)
              ? ('readable' as const)
              : denied
                ? ('denied' as const)
                : ('unknown' as const),
            ...(location.parentId === undefined ? {} : { parentId: location.parentId }),
            discovery: {
              runId,
              passes: location.passes,
              gaps: reasons,
              verifiedAt: Date.now(),
              scope: location.passes?.includes('joined-private')
                ? 'joined-private'
                : 'accessible-inventory',
            },
          };
          await this.mutate(state, () => state.repo.upsertChannel(record), interceptor);
          channels.set(location.id, record);
        }
      },
      revalidated: async (channelId, access, channel, reason) => {
        if (reason !== undefined && access !== 'deleted')
          progress.gap({
            sourceId: channelId,
            name: channel?.name ?? channels.get(channelId)?.name,
            reason: this.gapReason(reason),
          });
        const previous = channels.get(channelId);
        const record = {
          ...previous,
          channelId,
          name: channel?.name ?? previous?.name ?? '',
          type: channel?.type ?? previous?.type ?? -1,
          observedAt: Date.now(),
          access,
          ...(channel?.parentId === null || channel?.parentId === undefined
            ? {}
            : { parentId: channel.parentId }),
          discovery: {
            runId,
            gaps: reason === undefined || access === 'deleted' ? [] : [reason],
            verifiedAt: Date.now(),
          },
        };
        await this.mutate(state, () => state.repo.upsertChannel(record), interceptor);
        channels.set(channelId, record);
      },
      discovered: (ids) => {
        for (const id of ids) discovered.add(id);
        progress.setSources(discovered.size);
        if (!full) {
          const estimate = estimatePeriodicWork([...discovered], priors, cutoff, {
            policyHash: this.policyHash,
          });
          progress.setTotal(
            'history',
            estimate.total !== undefined &&
              estimate.total >= progress.checkpoint().phases.history.committed
              ? estimate.total
              : undefined,
            'estimated',
            'messages',
          );
          if (progress.checkpoint().phases.history.rates.length < 3)
            progress.seedRates('history', estimate.rates);
        }
      },
      load: async (channelId) => {
        const known = channels.get(channelId);
        const checkpoint = known?.checkpoint as unknown as HistoryCheckpoint | undefined;
        const cursor = await state.conn.models.Fetch.findOne({ channelID: channelId })
          .lean()
          .exec();
        return {
          ...(checkpoint === undefined ? {} : { checkpoint }),
          ...(cursor?.lastMessageID ? { lastMessageId: cursor.lastMessageID } : {}),
        };
      },
      checkpoint: async (channel, checkpoint) => {
        const checkpointStarted = performance.now();
        const old = channels.get(channel.id)?.checkpoint as unknown as
          | HistoryCheckpoint
          | undefined;
        const baseline = old?.estimatePrevious;
        const page = pageResults.get(channel.id);
        if (page !== undefined && (checkpoint.pageSequence ?? 0) > (old?.pageSequence ?? 0)) {
          const previous = (
            old as
              | (HistoryCheckpoint & {
                  statistics?: {
                    messages: ArchiveProgressSnapshot['messages'];
                    reactions: number;
                    countQuality?: 'exact' | 'lower-bound';
                  };
                })
              | undefined
          )?.statistics;
          const messages = {
            fetched: 0,
            scanned: (previous?.messages.scanned ?? 0) + page.admitted.length,
            admitted: (previous?.messages.admitted ?? 0) + (checkpoint.pageAdmitted ?? 0),
            excluded:
              (previous?.messages.excluded ?? 0) +
              Math.max(0, page.admitted.length - (checkpoint.pageAdmitted ?? 0)),
            inserted: (previous?.messages.inserted ?? 0) + page.counts.inserted,
            updated: (previous?.messages.updated ?? 0) + page.counts.updated,
            unchanged: (previous?.messages.unchanged ?? 0) + page.counts.unchanged,
            durable: (previous?.messages.durable ?? 0) + page.counts.durable,
          };
          Object.assign(checkpoint, {
            statistics: {
              messages,
              reactions: (previous?.reactions ?? 0) + page.reactions,
              countQuality:
                previous?.countQuality === 'lower-bound' ||
                (old !== undefined && (old.scanned ?? 0) > 0 && previous === undefined)
                  ? 'lower-bound'
                  : 'exact',
            },
          });
        }
        if (baseline !== undefined) checkpoint.estimatePrevious = baseline;
        if (
          !full &&
          checkpoint.complete &&
          checkpoint.startedAt !== undefined &&
          old !== undefined
        ) {
          const priorCutoff = baseline?.lastCutoff ?? priorCutoffs.get(channel.id) ?? cutoff;
          if (cutoff > priorCutoff)
            checkpoint.estimatePrevious = updatePeriodicHistory(baseline, {
              cutoff,
              scanned: checkpoint.scanned ?? 0,
              elapsedMs: Math.max(1, Date.now() - checkpoint.startedAt),
              windowMs: cutoff - priorCutoff,
              policyHash: this.policyHash,
            });
        }
        await this.mutate(
          state,
          () =>
            state.repo.upsertChannel({
              channelId: channel.id,
              name: channel.name,
              type: channel.type,
              observedAt: Date.now(),
              access: 'readable',
              ...(channel.parentId === null ? {} : { parentId: channel.parentId }),
              checkpoint: checkpoint as unknown as Record<string, unknown>,
            }),
          interceptor,
        );
        const detail = sanitizeArchiveProgress({
          phase: 'history',
          state: 'running',
          activities: [
            {
              sourceId: channel.id,
              name: channel.name,
              step: 'checkpoint',
              scanned: checkpoint.scanned ?? 0,
              startedAt: checkpoint.startedAt ?? Date.now(),
              updatedAt: Date.now(),
              cursor: checkpoint.before,
            },
          ],
        });
        await state.conn.connection.collection('archive_progress_details').updateOne(
          { guildId, scopeId: repair?.jobId ?? runId, sourceId: channel.id },
          {
            $set: {
              activity: detail?.activities[0],
              checkpoint: {
                version: checkpoint.version,
                complete: checkpoint.complete,
                before: checkpoint.before,
                latest: checkpoint.latest,
                scanned: checkpoint.scanned,
                admitted: checkpoint.admitted,
                statistics: (checkpoint as unknown as Record<string, unknown>)['statistics'],
              },
              updatedAt: Date.now(),
            },
          },
          { upsert: true },
        );
        const duration = performance.now() - checkpointStarted;
        this.durations.checkpointMs += duration;
        this.pipelineBudget.record('checkpoint', duration);
        const previous = channels.get(channel.id);
        channels.set(channel.id, {
          ...previous,
          channelId: channel.id,
          name: channel.name,
          type: channel.type,
          observedAt: Date.now(),
          access: 'readable',
          checkpoint: checkpoint as unknown as Record<string, unknown>,
        });
        if (checkpoint.complete && checkpoint.latest !== undefined) {
          await this.mutate(state, async () => {
            const collection = state.conn.models.Fetch.collection;
            const before = await collection.findOne({ channelID: channel.id });
            const old = typeof before?.lastMessageID === 'string' ? before.lastMessageID : '';
            if (/^\d+$/.test(old) && BigInt(old) >= BigInt(checkpoint.latest!)) return;
            const after = {
              ...before,
              _id: before?._id ?? new Types.ObjectId(),
              channelID: channel.id,
              channel: channel.name,
              lastMessageID: checkpoint.latest,
            };
            if (interceptor !== undefined)
              await interceptor(collection.collectionName, before, after, 'fetch-checkpoint');
            else if (before === null) await collection.insertOne(after);
            else await collection.replaceOne({ _id: before._id }, after);
          });
        }
      },
      consume: async (raw, channel) => {
        const admitted = await this.ingest(
          state,
          raw,
          channel,
          repair === undefined ? 'history' : 'repair',
          interceptor,
          signal,
          async (estimate) => {
            await checkSchedule();
            progress.setCurrentPhaseEstimate(estimate);
            await this.notify(guildId, state, repair?.jobId);
            await this.drainInbox(guildId);
          },
        );
        await this.drainInbox(guildId);
        return admitted;
      },
      consumePage: async (raws, channel) => {
        const page = await this.ingestPage(
          state,
          raws,
          channel,
          repair === undefined ? 'history' : 'repair',
          interceptor,
          signal,
          checkBoundary,
        );
        pageResults.set(channel.id, page);
        await this.drainInbox(guildId);
        return page.admitted;
      },
      afterPage: async () => {
        await checkBoundary();
        await this.drainInbox(guildId);
      },
      request: async (key, operation, requestSignal = signal) => {
        await checkSchedule();
        return this.scheduler.run(key, 'history', () => this.readObserved(state, operation), {
          signal: requestSignal,
          guildId,
        });
      },
      progress: async (channelId, count, checkpoint) => {
        if (progress.commit('history', count, channelId, checkpoint.pageSequence ?? 0)) {
          progress.observe('history', count, checkpoint.pageAdmitted ?? 0);
          progress.messageCounts({
            scanned: count,
            admitted: checkpoint.pageAdmitted ?? 0,
            excluded: Math.max(0, count - (checkpoint.pageAdmitted ?? 0)),
          });
          const page = pageResults.get(channelId);
          if (page !== undefined) {
            progress.messageCounts(page.counts);
            progress.reactionDiscovered(page.reactions);
            progress.reactionCompleted(page.reactions);
          }
          pageResults.delete(channelId);
        }
        await this.notify(guildId, state, repair?.jobId);
      },
    });
    await this.drainInbox(guildId);
    const pendingEvents = await state.conn.models.ArchiveInbox.countDocuments({
      state: { $in: ['pending', 'processing'] },
    }).exec();
    if (pendingEvents > 0)
      result.issues.push(`${pendingEvents} live archive event(s) remain unprocessed`);
    if (state.gapVersion !== gapVersion)
      result.issues.push('Gateway gap during scan; full reconciliation remains required');
    if (repair === undefined && state.periodicAbort?.signal.aborted)
      pauseReason = 'Queued archive maintenance';
    if (pauseReason !== undefined && !result.issues.includes(pauseReason))
      result.issues.push(pauseReason);
    if (result.issues.length === 0) {
      state.fullRequired = false;
      state.gap = false;
    }
    for (const issue of result.issues) {
      const sourceId = /^(\d+):/.exec(issue)?.[1];
      if (sourceId !== undefined || progress.snapshot().gapCount === 0)
        progress.gap({
          sourceId,
          name: sourceId === undefined ? undefined : channels.get(sourceId)?.name,
          reason: this.gapReason(issue),
        });
    }
    const status =
      cancellation.signal.aborted || state.signal.signal.aborted
        ? 'cancelled'
        : result.issues.length > 0
          ? 'partial'
          : 'complete';
    if (status === 'complete')
      for (const phase of ['discovery', 'history', 'reactions', 'repair', 'verification'] as const)
        progress.setTotal(phase, progress.checkpoint().phases[phase].committed);
    progress.finish(status, pauseReason);
    return {
      status,
      counts: { scanned: result.scanned, channels: result.channels, pendingEvents },
      details: {
        progress: {
          ...progress.snapshot(),
          rest: this.telemetry.snapshot(),
          scheduler: this.scheduler.snapshot(),
        },
      },
      issues: result.issues,
    };
  }

  private async notify(
    guildId: string,
    state: GuildWorker,
    jobId?: string,
    force = false,
  ): Promise<void> {
    try {
      await this.publishProgress(guildId, state, jobId, force);
    } catch (error) {
      this.options.logger.warn(
        { guildId, jobId, err: error },
        'Archive progress publication deferred',
      );
    }
  }

  private async startProgressPublication(
    guildId: string,
    state: GuildWorker,
    jobId?: string,
    scanId?: string,
  ): Promise<void> {
    clearInterval(state.heartbeat);
    await state.notifications?.stop();
    const generation = randomUUID();
    state.progressScope = { generation, jobId, scanId };
    state.detailSignatures = new Map();
    state.notifiedAt = 0;
    state.progressRoute = undefined;
    state.notifications = new ProgressNotifier(async (snapshot) => {
      if (this.stopped || state.progressScope?.generation !== generation) return;
      const notifier = new ArchiveJobNotifier({
        client: this.options.client,
        translator: this.options.translator,
        registry: this.options.registry,
        logger: this.options.logger,
        connection: state.conn.connection,
        guildId,
      });
      try {
        await this.persistProgressDetails(state, jobId ?? scanId ?? generation);
        if (jobId !== undefined) {
          const job = await state.repo.getJob(jobId);
          if (job === undefined || job.status !== 'running') return;
          const saved = await state.conn.connection
            .collection<ArchiveJob>('archive_jobs')
            .updateOne(
              { jobId, guildId, status: 'running', claimToken: ARCHIVE_PROCESS_ID },
              { $set: { 'result.progress': snapshot, leaseUntil: Date.now() + 60000 } },
            );
          if (saved.matchedCount === 0 || state.progressScope?.generation !== generation) return;
          await this.scheduler.run(
            `notify:${guildId}:${jobId}`,
            'live',
            () => notifier.publish(job, snapshot, true),
            { signal: state.signal.signal },
          );
        } else if (scanId !== undefined) {
          const saved = await state.conn.connection
            .collection<ArchivePeriodicRun>('archive_periodic_runs')
            .updateOne({ _id: 'current', runId: scanId }, { $set: { progress: snapshot } });
          if (saved.matchedCount === 0 || state.progressScope?.generation !== generation) return;
          await this.scheduler.run(
            `notify:${guildId}:${scanId}`,
            'live',
            () => notifier.publishScan(scanId, snapshot, true),
            { signal: state.signal.signal },
          );
        }
      } catch (error) {
        this.options.logger.warn(
          { guildId, jobId, scanId, err: error },
          'Archive progress publication deferred',
        );
        throw error;
      }
    }, this.options.config.progress_interval_seconds * 1000);
    state.heartbeat = setInterval(() => {
      if (state.progressScope?.generation !== generation || this.stopped) return;
      void this.notify(guildId, state, jobId);
      if (state.heartbeatWork !== undefined) return;
      state.heartbeatWork = this.observeLiveProgress(state)
        .catch((error: unknown) => {
          this.options.logger.warn(
            { guildId, err: error },
            'Archive heartbeat observation deferred',
          );
        })
        .finally(() => {
          state.heartbeatWork = undefined;
        });
    }, this.options.config.progress_interval_seconds * 1000);
    state.heartbeat.unref();
  }

  private async persistProgressDetails(state: GuildWorker, scopeId: string): Promise<void> {
    const progress = state.progress;
    if (progress === undefined) return;
    const rows = new Map<
      string,
      {
        activity?: ArchiveProgressSnapshot['activities'][number];
        gaps: ReturnType<ProgressTracker['gapDetails']>;
      }
    >();
    for (const activity of progress.activityDetails())
      rows.set(activity.sourceId, { activity, gaps: [] });
    for (const gap of progress.gapDetails()) {
      const key = `${gap.sourceId ?? 'scope'}:gap:${gap.reason}`;
      rows.set(key, { gaps: [gap] });
    }
    const signatures = (state.detailSignatures ??= new Map());
    const operations = [];
    const changed: [string, string][] = [];
    for (const [sourceId, row] of rows) {
      const safe = sanitizeArchiveProgress({
        phase: 'history',
        state: 'running',
        activities: row.activity === undefined ? [] : [row.activity],
        gaps: row.gaps,
      });
      const detail = {
        ...(safe?.activities[0] === undefined ? {} : { activity: safe.activities[0] }),
        gaps: safe?.gaps ?? [],
      };
      const signature = JSON.stringify(detail);
      if (signatures.get(sourceId) === signature) continue;
      operations.push({
        updateOne: {
          filter: { guildId: String(state.conn.guildId), scopeId, sourceId },
          update: { $set: { ...detail, updatedAt: Date.now() } },
          upsert: true,
        },
      });
      if (operations.length === 500) {
        await state.conn.connection
          .collection('archive_progress_details')
          .bulkWrite(operations, { ordered: true });
        operations.length = 0;
      }
      changed.push([sourceId, signature]);
    }
    if (operations.length > 0)
      await state.conn.connection
        .collection('archive_progress_details')
        .bulkWrite(operations, { ordered: true });
    for (const [key, value] of changed) signatures.set(key, value);
  }

  private async observeLiveProgress(state: GuildWorker): Promise<void> {
    const progress = state.progress;
    const generation = state.progressScope?.generation;
    if (progress === undefined) return;
    const collection = state.conn.models.ArchiveInbox.collection;
    const pending = await collection.countDocuments(
      { state: { $in: ['pending', 'processing'] } },
      { maxTimeMS: 5000 },
    );
    const oldest = await collection.findOne(
      { state: { $in: ['pending', 'processing'] } },
      { sort: { observedAt: 1 }, projection: { observedAt: 1 }, maxTimeMS: 5000 },
    );
    if (state.progressScope?.generation !== generation) return;
    this.durations.inboxOldestAgeMs =
      oldest === null ? 0 : Math.max(0, Date.now() - oldest.observedAt);
    progress.setExtras({
      live: {
        pending,
        oldestAgeMs: oldest === null ? 0 : Math.max(0, Date.now() - oldest.observedAt),
        windowMs: this.options.config.progress_interval_seconds * 1000,
      },
    });
    if (
      state.progressScope?.jobId !== undefined &&
      (await state.repo.getJob(state.progressScope.jobId))?.cancelRequested
    )
      progress.setState('cancelling');
  }

  private async publishProgress(
    guildId: string,
    state: GuildWorker,
    jobId?: string,
    force = false,
  ): Promise<void> {
    if (state.progress === undefined || this.stopped) return;
    if (state.notifications === undefined)
      await this.startProgressPublication(guildId, state, jobId, state.progress.snapshot().scanId);
    const snapshot = state.progress.snapshot();
    const route = `${snapshot.state}:${snapshot.phase}:${snapshot.substep}`;
    await state.notifications?.update(snapshot, force || state.progressRoute !== route);
    state.progressRoute = route;
  }

  private async closeProgressPublication(state: GuildWorker, deliverFinal = false): Promise<void> {
    clearInterval(state.heartbeat);
    state.heartbeat = undefined;
    await state.heartbeatWork;
    if (deliverFinal && state.progress !== undefined) {
      await state.notifications?.update(state.progress.snapshot(), true);
      await state.notifications?.drain();
    }
    await state.notifications?.stop();
    state.notifications = undefined;
    state.progressScope = undefined;
    state.progressRoute = undefined;
  }

  private async publishJobNotification(
    guildId: string,
    state: GuildWorker,
    job: ArchiveJob,
    snapshot: ArchiveProgressSnapshot,
  ): Promise<void> {
    const notifier = new ArchiveJobNotifier({
      client: this.options.client,
      translator: this.options.translator,
      registry: this.options.registry,
      logger: this.options.logger,
      connection: state.conn.connection,
      guildId,
    });
    await this.scheduler.run(`notify:${guildId}:${job.jobId}`, 'live', () =>
      notifier.publish(job, snapshot),
    );
  }

  private async recoverControlDeletions(guildId: string, state: GuildWorker): Promise<void> {
    const receipts = await archiveJobDeletions(state.conn.connection)
      .find({ guildId, notifiedAt: { $exists: false } })
      .limit(25)
      .toArray();
    const notifier = new ArchiveJobNotifier({
      client: this.options.client,
      translator: this.options.translator,
      registry: this.options.registry,
      logger: this.options.logger,
      connection: state.conn.connection,
      guildId,
    });
    for (const receipt of receipts) {
      if (await finalizeArchiveJobDeletion(state.conn.connection, guildId, receipt.jobId))
        await notifier.publishDeleted(receipt.jobId);
    }
    const runs = await state.conn.connection
      .collection<{ _id: string }>('archive_repair_runs')
      .find({ guildId, deleteRequestedAt: { $exists: true } }, { projection: { _id: 1 } })
      .limit(25)
      .toArray();
    const control = new ArchiveControlService(state.conn.connection, guildId);
    for (const run of runs) await control.deletePlan(run._id);
  }

  private async notifyJobResult(guildId: string, state: GuildWorker, jobId: string): Promise<void> {
    try {
      const job = await state.repo.getJob(jobId);
      if (job === undefined) return;
      if (job.deleteRequestedAt !== undefined && job.status !== 'running') {
        await this.recoverControlDeletions(guildId, state);
        return;
      }
      await this.publishJobNotification(guildId, state, job, archiveJobProgress(job));
    } catch (error) {
      this.options.logger.warn(
        { guildId, jobId, err: error },
        'Archive result notification deferred',
      );
    }
  }

  private async retryJobNotifications(guildId: string, state: GuildWorker): Promise<void> {
    const jobs = await state.conn.connection
      .collection<ArchiveJob>('archive_jobs')
      .find({
        guildId,
        status: { $in: ['complete', 'partial', 'failed', 'cancelled'] },
        'notification.channelId': { $exists: true },
        'notification.supersededAt': { $exists: false },
        $expr: { $ne: [{ $ifNull: ['$notification.deliveredStatus', ''] }, '$status'] },
        $or: [
          { 'notification.nextAttemptAt': { $exists: false } },
          { 'notification.nextAttemptAt': { $lte: Date.now() } },
        ],
      })
      .sort({ finishedAt: -1 })
      .limit(5)
      .toArray();
    for (const job of jobs) await this.notifyJobResult(guildId, state, job.jobId);
    const run = await state.conn.connection
      .collection<ArchivePeriodicRun>('archive_periodic_runs')
      .findOne({ _id: 'current' });
    if (
      run !== null &&
      ['complete', 'partial', 'failed', 'cancelled'].includes(run.status) &&
      run.notification?.deliveredStatus !== run.status &&
      (run.notification?.nextAttemptAt ?? 0) <= Date.now()
    ) {
      const progress = sanitizeArchiveProgress(
        run.progress ??
          run.result?.['progress'] ??
          (run.result?.['details'] as Record<string, unknown> | undefined)?.['progress'],
      );
      if (progress !== undefined) {
        const notifier = new ArchiveJobNotifier({
          client: this.options.client,
          translator: this.options.translator,
          registry: this.options.registry,
          logger: this.options.logger,
          connection: state.conn.connection,
          guildId,
        });
        await this.scheduler.run(
          `notify:${guildId}:${run.runId}`,
          'live',
          () => notifier.publishScan(run.runId, progress),
          { signal: state.signal.signal },
        );
      }
    }
  }

  private async refreshAttachment(
    state: GuildWorker,
    options: Record<string, unknown>,
    onStep?: (completed: number, substep: string) => Promise<void>,
  ): Promise<RepairResult> {
    if (!state.ready)
      return { status: 'partial', counts: {}, issues: ['structural-maintenance-required'] };
    const { channelId, messageId, attachmentId, userId } = options;
    if (
      ![channelId, messageId, attachmentId, userId].every(
        (id) => typeof id === 'string' && /^\d+$/.test(id),
      )
    ) {
      throw new TypeError(
        'Attachment refresh requires channelId, messageId, attachmentId and userId snowflakes',
      );
    }
    const guildId = String(state.conn.guildId);
    const guild = await this.options.client.guilds.fetch(guildId);
    if (!(await canReadArchiveSource(guild, channelId as string, userId as string))) {
      return { status: 'partial', counts: {}, issues: ['source-inaccessible'] };
    }
    await onStep?.(1, 'attachment-fetch');
    try {
      const raw = (await this.scheduler.run(
        `attachment:${channelId}:${messageId}`,
        'live',
        () =>
          this.readObserved(state, () =>
            this.options.client.rest.get(
              Routes.channelMessage(channelId as string, messageId as string),
              { signal: state.signal.signal },
            ),
          ),
        { signal: state.signal.signal, guildId, resourceId: channelId as string },
      )) as Record<string, unknown>;
      await onStep?.(2, 'attachment-write');
      const attachments = Array.isArray(raw.attachments)
        ? (raw.attachments as Record<string, unknown>[])
        : [];
      const attachment = attachments.find((item) => item.id === attachmentId);
      if (attachment === undefined || typeof attachment.url !== 'string')
        return { status: 'partial', counts: {}, issues: ['attachment-removed'] };
      const snapshot = normalizeMessage(raw, {
        guildId,
        channelId: channelId as string,
        source: 'history',
        observedAt: Date.now(),
      });
      if (!(await this.saveSnapshot(state, snapshot)))
        return { status: 'partial', counts: {}, issues: ['source-excluded-or-deleted'] };
      await onStep?.(3, 'attachment-write');
      return {
        status: 'complete',
        counts: { refreshed: 1 },
        issues: [],
        details: { attachmentId, url: attachment.url, observedAt: Date.now() },
      };
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      const reason =
        code === 10008
          ? 'source-deleted'
          : code === 50001 || code === 50013
            ? 'source-inaccessible'
            : 'refresh-temporarily-unavailable';
      return { status: 'partial', counts: {}, issues: [reason] };
    }
  }

  private async sweepReactionGarbage(state: GuildWorker): Promise<void> {
    if ((state.nextGarbageAt ?? 0) > Date.now() || !state.ready) return;
    state.nextGarbageAt = Date.now() + 60_000;
    const checkpoints = state.conn.connection.collection<{ _id: string; after?: string }>(
      'archive_gc_checkpoints',
    );
    const previous = await checkpoints.findOne({ _id: 'reactions' });
    const olderThan = Date.now() - 86_400_000;
    const candidates = await state.conn.models.ArchiveReaction.collection
      .aggregate<{
        _id: string;
      }>(
        [
          {
            $match: {
              observedAt: { $lt: olderThan },
              ...(previous?.after ? { messageId: { $gt: previous.after } } : {}),
            },
          },
          { $group: { _id: '$messageId' } },
          { $sort: { _id: 1 } },
          { $limit: 100 },
        ],
        { allowDiskUse: true },
      )
      .toArray();
    for (const candidate of candidates) {
      if (this.stopped) return;
      await this.mutate(state, () =>
        state.repo.collectReactionGarbage(
          candidate._id,
          [...(state.generations.get(candidate._id) ?? [])],
          olderThan,
        ),
      );
      await checkpoints.updateOne(
        { _id: 'reactions' },
        { $set: { after: candidate._id } },
        { upsert: true },
      );
    }
    if (candidates.length === 0)
      await checkpoints.updateOne({ _id: 'reactions' }, { $unset: { after: 1 } }, { upsert: true });
  }

  public async pollJobs(guildId: string): Promise<void> {
    if (this.stopped) return;
    const state = await this.initialize(guildId);
    if (state.jobWork !== undefined) return state.jobWork;
    const work = this.runJobs(state, guildId);
    state.jobWork = work;
    try {
      await work;
    } finally {
      if (state.jobWork === work) state.jobWork = undefined;
    }
  }

  private async runJobs(state: GuildWorker, guildId: string): Promise<void> {
    if (state.working === 'job') return;
    if (state.working === 'periodic') {
      const queued = await state.conn.connection
        .collection<ArchiveJob>('archive_jobs')
        .findOne(
          { guildId, status: 'queued', cancelRequested: false },
          { projection: { jobId: 1 } },
        );
      if (queued === null) return;
      state.periodicAbort?.abort();
      await state.periodicWork;
      await state.writer.drain();
    }
    state.working = 'job';
    try {
      await this.retryJobNotifications(guildId, state).catch((error: unknown) => {
        this.options.logger.warn({ guildId, err: error }, 'Archive notification retry deferred');
      });
      await recoverArchiveRunConsumers(state.conn.connection, guildId);
      await this.recoverControlDeletions(guildId, state);
      const job = await state.repo.claimJob(ARCHIVE_PROCESS_ID, Date.now(), 60_000);
      const deletion =
        job === undefined
          ? null
          : await archiveJobDeletions(state.conn.connection).findOne({
              _id: 'job:' + job.jobId,
              guildId,
            });
      if (job !== undefined && (job.cancelRequested || deletion !== null)) {
        await state.repo.updateJob(
          job.jobId,
          {
            status: 'cancelled',
            finishedAt: Date.now(),
            ...(deletion === null
              ? {}
              : { deleteRequestedAt: deletion.requestedAt, cancelRequested: true }),
          },
          ARCHIVE_PROCESS_ID,
        );
        await this.notifyJobResult(guildId, state, job.jobId);
        return;
      }
      if (job?.command === 'refresh-attachment') {
        state.progress = undefined;
        let terminal: Partial<ArchiveJob>;
        try {
          state.progress = new ProgressTracker({
            cutoff: new Date(job.createdAt),
            startedAt: job.startedAt ?? job.createdAt,
            work: job.command,
            jobId: job.jobId,
            runId: job.runId,
          });
          for (const phase of ['discovery', 'history', 'reactions', 'verification'] as const)
            state.progress.setTotal(phase, 0);
          state.progress.report(
            'repair',
            0,
            3,
            'exact',
            'checks',
            'attachment-access',
            'attachment',
          );
          await this.notify(guildId, state, job.jobId, true);
          const result = await this.refreshAttachment(
            state,
            job.options,
            async (completed, substep) => {
              state.progress?.report(
                'repair',
                completed,
                3,
                'exact',
                'checks',
                substep,
                'attachment',
              );
              await this.notify(guildId, state, job.jobId, true);
            },
          );
          for (const issue of result.issues) state.progress.gap({ reason: this.gapReason(issue) });
          state.progress.finish(
            state.signal.signal.aborted || (await state.repo.getJob(job.jobId))?.cancelRequested
              ? 'cancelled'
              : result.status,
          );
          if (
            state.signal.signal.aborted ||
            (await state.repo.getJob(job.jobId))?.cancelRequested
          ) {
            terminal = {
              status: 'cancelled',
              result: { ...result, progress: state.progress.snapshot() },
              finishedAt: Date.now(),
            };
          } else {
            terminal = {
              status: result.status,
              result: { ...result, progress: state.progress.snapshot() } as unknown as Record<
                string,
                unknown
              >,
              finishedAt: Date.now(),
            };
          }
        } catch (error) {
          terminal = {
            status: 'failed',
            result: { issues: [String(error)] },
            finishedAt: Date.now(),
          };
        }
        await this.closeProgressPublication(state);
        await state.repo.updateJob(job.jobId, terminal, ARCHIVE_PROCESS_ID);
        await this.notifyJobResult(guildId, state, job.jobId);
        return;
      }
      let terminal: Partial<ArchiveJob>;
      let cleanupAccepted: (() => Promise<number>) | undefined;
      if (job !== undefined) state.progress = undefined;
      try {
        if (job !== undefined) {
          state.progress = new ProgressTracker({
            cutoff: new Date(job.createdAt),
            startedAt: job.startedAt ?? job.createdAt,
            work: job.command,
            jobId: job.jobId,
            runId: job.runId,
          });
          state.progress.setPhase('repair');
          state.progressMessage = undefined;
          state.notifications = undefined;
          state.notifiedAt = 0;
          await this.notify(guildId, state, job.jobId, true);
        }
        const { ArchiveRepairService } = await import('../repair/service');
        const service = new ArchiveRepairService(state.conn.connection, {
          signal: state.signal.signal,
          policyHash: this.policyHash,
          schemaHash: 'archive-v2',
          classify: (document) => {
            const evidence = document.archiveSourceDecision as
              | { policyHash?: string; admitted?: boolean }
              | undefined;
            if (evidence?.policyHash === this.policyHash && evidence.admitted === false)
              return 'excluded';
            const decision = evaluatePolicy(
              { ...document, guildId } as unknown as ArchiveSnapshot,
              this.options.policy,
            );
            return decision.unresolved ? 'unknown' : decision.admitted ? 'included' : 'excluded';
          },
          assertOwner: async () => {
            const started = performance.now();
            try {
              if (!(await state.repo.acquireOwner(ARCHIVE_PROCESS_ID, Date.now())))
                throw new Error('Archive owner lost');
            } finally {
              this.durations.ownerRenewalMs += performance.now() - started;
            }
          },
          withCapacity: (bytes, operation) => state.storage.withReservation(bytes, true, operation),
          ensureCapacity: async (bytes) => {
            await state.storage.reserve(bytes, true);
          },
          withMaintenance: async (operation) => {
            state.ready = false;
            await state.draining;
            await state.writer.drain();
            try {
              return await operation();
            } finally {
              const indexes = await state.conn.models.Message.collection.indexes();
              state.ready = indexes.some(
                (index) =>
                  index.unique === true &&
                  index.sparse !== true &&
                  index.partialFilterExpression === undefined &&
                  index.key.messageId === 1 &&
                  Object.keys(index.key).length === 1,
              );
            }
          },
          onProgress: async (phase, committed, total, stream = phase, metadata) => {
            if (job === undefined || state.progress === undefined) return;
            const progress = state.progress;
            const before = progress.snapshot();
            const unit =
              metadata?.unit ??
              (['apply', 'resume', 'rollback'].includes(job.command) ? 'operations' : 'documents');
            const quality = metadata?.quality ?? 'unknown';
            progress.report(
              phase,
              committed,
              total,
              quality,
              unit,
              metadata?.substep ?? phase,
              stream,
            );
            progress.setExtras({
              ...(metadata?.candidates === undefined ? {} : { candidates: metadata.candidates }),
              ...(metadata?.outcomes === undefined ? {} : { outcomes: metadata.outcomes }),
            });
            await this.notify(
              guildId,
              state,
              job.jobId,
              before.phase !== phase || before.substep !== progress.snapshot().substep,
            );
          },
          isCancelled: async (jobId) =>
            this.stopped || (await state.repo.getJob(jobId))?.cancelRequested === true,
          backfill: async (context) => {
            state.ready = true;
            return this.scan(state, context.runId, context.cutoff, true, context);
          },
        });
        cleanupAccepted = () => service.cleanupAccepted();
        if (job === undefined) {
          await this.drainInbox(guildId);
          await this.sweepReactionGarbage(state);
          try {
            await service.cleanupAccepted();
          } catch (error) {
            this.options.logger.warn({ guildId, err: error }, 'Archive recovery cleanup deferred');
          }
          return;
        }
        const result = await service.execute({ ...job, command: job.command });
        if (state.progress !== undefined) {
          if (result.status === 'complete')
            for (const phase of [
              'discovery',
              'history',
              'reactions',
              'repair',
              'verification',
            ] as const)
              state.progress.setTotal(phase, state.progress.checkpoint().phases[phase].committed);
          for (const issue of result.issues) state.progress.gap({ reason: this.gapReason(issue) });
          if (result.status === 'partial') {
            const run =
              job.runId === undefined
                ? null
                : await state.conn.connection
                    .collection<{ _id: string; status: string }>('archive_repair_runs')
                    .findOne({ _id: job.runId });
            state.progress.setExtras({
              nextAction:
                run !== null &&
                ['applying', 'enriching', 'verifying', 'partial'].includes(String(run['status']))
                  ? 'resume'
                  : ['plan', 'backfill', 'migrate-timestamp'].includes(job.command)
                    ? 'replan'
                    : 'status',
            });
          }
          state.progress.finish(
            result.status,
            result.issues.length > 0 ? result.issues[0] : undefined,
          );
        }
        terminal = {
          status: result.status,
          result: {
            ...result,
            ...(state.progress === undefined
              ? {}
              : {
                  progress: {
                    ...state.progress.snapshot(),
                    rest: this.telemetry.snapshot(),
                    scheduler: this.scheduler.snapshot(),
                  },
                }),
          },
          finishedAt: Date.now(),
          ...(result.runId === undefined ? {} : { runId: result.runId }),
        };
      } catch (error) {
        if (job === undefined) throw error;
        if (state.progress !== undefined) state.progress.finish('failed', String(error));
        terminal = {
          status: 'failed',
          result: {
            issues: [String(error)],
            ...(state.progress === undefined
              ? {}
              : {
                  progress: {
                    ...state.progress.snapshot(),
                    rest: this.telemetry.snapshot(),
                    scheduler: this.scheduler.snapshot(),
                  },
                }),
          },
          finishedAt: Date.now(),
        };
      }
      if (job === undefined) return;
      // Delivery is outside execution failure handling and follows durable completion.
      await this.closeProgressPublication(state);
      await state.repo.updateJob(job.jobId, terminal, ARCHIVE_PROCESS_ID);
      await this.notifyJobResult(guildId, state, job.jobId);
      if (cleanupAccepted !== undefined)
        await cleanupAccepted().catch((error: unknown) => {
          this.options.logger.warn({ guildId, err: error }, 'Archive recovery cleanup deferred');
        });
    } finally {
      state.working = undefined;
    }
  }

  public cancel(): void {
    this.stopped = true;
    for (const state of this.states.values()) state.signal.abort();
    this.scheduler.stop();
  }

  public async stop(): Promise<void> {
    const started = performance.now();
    this.cancel();
    await Promise.allSettled([...this.initializing.values()]);
    await Promise.allSettled([...this.captures]);
    await Promise.allSettled(
      [...this.states.values()].flatMap((state) =>
        [state.periodicWork, state.jobWork].filter(
          (work): work is Promise<void> => work !== undefined,
        ),
      ),
    );
    for (const state of this.states.values()) {
      await this.closeProgressPublication(state);
      await state.inboxWriter.stop();
      await state.writer.stop();
      await state.repo.releaseOwner(ARCHIVE_PROCESS_ID);
    }
    this.storage?.stop();
    this.durations.shutdownDrainMs += performance.now() - started;
    this.options.logger.info(
      {
        process: this.performanceSampler.stop(),
        pipeline: this.pipelineBudget.snapshot(),
        durations: this.durations,
        writers: [...this.states.values()].map((state) => ({
          guildId: String(state.conn.guildId),
          writer: state.writer.snapshot(),
          inboxWriter: state.inboxWriter.snapshot(),
        })),
      },
      'Archive worker performance',
    );
    this.telemetry.detach();
  }
}
