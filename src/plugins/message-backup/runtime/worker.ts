import { asGuildId } from '../../../core/ids';
import { beginArchiveContinuity } from '../../../core/archive/continuity';
import { ArchivePerformanceSampler } from '../../../core/archive/performance';
import { ARCHIVE_PROCESS_ID } from '../../../infra/archive/owner';
import { archivePerformanceLog, archiveWriterPerformanceLog } from '../flow/performance-log';
import { ArchiveRestTelemetry } from '../flow/rest-telemetry';
import { ArchiveScheduler } from '../flow/scheduler';
import { GatewayCapture } from './capture';
import { ChannelLocator } from './channel-location';
import { GatewayContinuity } from './continuity';
import { ArchiveDirtyTracker } from './dirty-tracker';
import type { ArchiveGatewayEvent } from './gateway-event';
import { ArchiveInboxReducer } from './inbox-reducer';
import { ArchiveInvalidRequestMonitor } from './invalid-request-monitor';
import { HistoryIngestor } from './ingestor';
import { JobRunner } from './job-runner';
import { NotificationRecovery } from './notification-recovery';
import { SourceObservations } from './observations';
import { releaseTerminatedArchiveOwner } from './owner-recovery';
import { PeriodicRunner } from './periodic-runner';
import { ProgressPublisher } from './progress-publisher';
import { ReactionRefresher } from './reaction-refresh';
import { ScanRunner } from './scan-runner';
import { ArchiveSerialWriter } from './serial-writer';
import { ArchiveStorageReporter } from './storage-reporter';
import { ArchiveWorkSlot } from './work-slot';
import {
  ArchiveWorkerContext,
  type ArchiveGuildState,
  type ArchiveWorkerOptions,
} from './worker-context';

/**
 * How often Gateway continuity is confirmed and persisted. A stale confirmation only
 * moves the next boot's restart rescan earlier.
 */
const CONTINUITY_HEARTBEAT_MS = 30_000;

/**
 * One process owns archive writes and consumes durable Discord control jobs. The
 * worker keeps each guild's state and lifecycle and routes Gateway events, polls
 * and passes to its collaborators.
 *
 * Pattern: Facade — the plugin sees one worker; capture, inbox reduction, scans,
 * periodic passes and full backups are collaborators wired here, each receiving
 * only the narrow ports it uses.
 */
export class ArchiveWorker {
  private readonly initializing = new Map<string, Promise<ArchiveGuildState>>();
  private readonly storageReporter: ArchiveStorageReporter;
  private readonly performanceSampler = new ArchivePerformanceSampler(1000);
  private readonly ctx: ArchiveWorkerContext;
  private readonly continuity: GatewayContinuity;
  private readonly gateway: GatewayCapture;
  private readonly inbox: ArchiveInboxReducer;
  private readonly progress: ProgressPublisher;
  private readonly periodicRunner: PeriodicRunner;
  private readonly jobs: JobRunner;
  private readonly invalidRequests: ArchiveInvalidRequestMonitor;

  public constructor(private readonly options: ArchiveWorkerOptions) {
    this.performanceSampler.start();
    const scheduler = new ArchiveScheduler({ concurrency: options.config.concurrency });
    const telemetry = new ArchiveRestTelemetry(Date.now, (wait) => {
      scheduler.observeWait(wait);
      for (const state of this.ctx.states.values())
        for (const activity of state.progress?.activityDetails() ?? [])
          if (
            (wait.global || activity.sourceId === wait.channelId) &&
            ['fetching', 'reactions', 'waiting'].includes(activity.step)
          )
            state.progress?.activity(activity.sourceId, {
              step: 'waiting',
              waitSince: activity.waitSince ?? Date.now(),
              retryAt: wait.deadlineAt,
            });
    });
    const ctx = new ArchiveWorkerContext(options, scheduler, telemetry, (guildId) =>
      this.initialize(guildId),
    );
    this.ctx = ctx;
    const observations = new SourceObservations();
    const locator = new ChannelLocator(ctx);
    const reactions = new ReactionRefresher(ctx, observations);
    const ingestor = new HistoryIngestor(ctx, observations, locator, reactions);
    const notifications = new NotificationRecovery(ctx);
    this.continuity = new GatewayContinuity(ctx);
    this.gateway = new GatewayCapture(ctx, this.continuity, locator);
    this.inbox = new ArchiveInboxReducer(ctx, {
      continuity: this.continuity,
      locator,
      ingestor,
      observations,
    });
    this.progress = new ProgressPublisher(ctx);
    const scanner = new ScanRunner(ctx, {
      continuity: this.continuity,
      locator,
      ingestor,
      observations,
      progress: this.progress,
      inbox: this.inbox,
    });
    this.periodicRunner = new PeriodicRunner(ctx, {
      continuity: this.continuity,
      inbox: this.inbox,
      scanner,
      progress: this.progress,
      notifications,
    });
    this.jobs = new JobRunner(ctx, {
      continuity: this.continuity,
      inbox: this.inbox,
      reactions,
      scanner,
      progress: this.progress,
      notifications,
    });
    this.storageReporter = new ArchiveStorageReporter(ctx);
    this.invalidRequests = new ArchiveInvalidRequestMonitor(
      ctx,
      notifications,
      Date.now,
      options.invalidRequestCheckMs,
    );
    if (typeof options.client.rest.on === 'function') telemetry.attach(options.client.rest);
    this.invalidRequests.start();
  }

  public async initialize(guildId: string): Promise<ArchiveGuildState> {
    const initializing = this.initializing.get(guildId);
    if (initializing !== undefined) return initializing;
    const existing = this.ctx.states.get(guildId);
    if (existing !== undefined) return existing;
    const work = this.open(guildId);
    this.initializing.set(guildId, work);
    try {
      return await work;
    } catch (error) {
      const failed = this.ctx.states.get(guildId);
      this.ctx.states.delete(guildId);
      await failed?.repos.owner.releaseOwner(ARCHIVE_PROCESS_ID).catch((releaseError: unknown) => {
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

  private async open(guildId: string): Promise<ArchiveGuildState> {
    if (!this.options.guildIds.includes(guildId) || this.ctx.stopped)
      throw new Error('Guild is outside archive scope');
    const conn = await this.options.connections.getConnection(asGuildId(guildId));
    const repos = this.options.writerRepos(conn);
    if (!(await repos.owner.acquireOwner(ARCHIVE_PROCESS_ID, Date.now()))) {
      if (
        !(await releaseTerminatedArchiveOwner(conn, repos.owner)) ||
        !(await repos.owner.acquireOwner(ARCHIVE_PROCESS_ID, Date.now()))
      ) {
        throw new Error('Archive owner is active or not proven drained');
      }
    }
    const storage = this.storageReporter.monitorFor(conn);
    storage.start();
    const archive = this.options.archiveRepos(conn);
    const continuity = archive.continuity;
    const currentRun = await archive.periodicRuns.currentOrigin();
    const currentBackup = await repos.jobs.latestBackupOrigin();
    // Either run may hold the newest gap version a lost continuity write never saved.
    const runGapVersions = [
      currentRun?.origin?.gapVersion,
      currentBackup?.origin?.gapVersion,
    ].filter((version): version is number => version !== undefined);
    const begun = beginArchiveContinuity(
      await continuity.read(),
      this.ctx.bootId,
      Date.now(),
      runGapVersions.length === 0 ? undefined : Math.max(...runGapVersions),
    );
    const state: ArchiveGuildState = {
      conn,
      repos,
      archive,
      notifier: this.options.backupNotifiers(archive.control),
      writer: new ArchiveSerialWriter(this.options.config.max_pending_events),
      storage,
      signal: new AbortController(),
      ready: false,
      continuity: {
        repo: continuity,
        write: Promise.resolve(),
        fullRequired: begun.fullRequired,
        gapVersion: begun.gapVersion,
        continuousSince: begun.continuousSince,
        confirmedAt: begun.confirmedAt,
        breakIndex: begun.breakIndex,
        breaks: begun.breaks,
      },
      dirty: new ArchiveDirtyTracker(this.options.config.max_pending_events * 10),
      captureVersions: new Map(),
      publication: {},
      reactions: { generations: new Map() },
      inbox: { writer: new ArchiveSerialWriter(this.options.config.max_pending_events) },
      work: new ArchiveWorkSlot(),
    };
    this.ctx.states.set(guildId, state);
    // Durable before any capture in this boot, so a crash still records the downtime.
    await this.continuity.persistContinuity(state, 'begin');
    // Events dropped before this guild had a state may hide any change.
    if (this.gateway.takeDropped(guildId)) await this.continuity.flagGapSafely(state);
    // Collection creation/index maintenance is explicit and occurs only after
    // ownership. Existing messages without the schema 3 indexes are an archive
    // that was not isolated before the upgrade; the guild stays in capture-only
    // mode until the rebuild replaces it (`docs/upgrading.md`).
    await storage.withReservation(1_048_576, false, async () => {
      await repos.owner.ensureArchiveCollections();
      try {
        await repos.owner.prepareMessageCollections();
        state.ready = true;
      } catch (error) {
        this.options.logger.error(
          { guildId, err: error },
          'Archive structural maintenance required; capture-only mode',
        );
      }
    });
    // Never reclaim work simply because its lease timer expired. The prior process
    // was proven terminated and drained before this recovery point.
    await repos.inbox.releaseProcessingInbox();
    // A full backup interrupted by a restart resumes with its cutoff and checkpoints;
    // one whose stop was requested ends stopped.
    await repos.jobs.recoverInterruptedBackups();
    // `cancel` clears timers of opened guilds; one opening concurrently starts none.
    if (!this.ctx.stopped) {
      state.continuity.timer = setInterval(() => {
        void this.continuity.heartbeatContinuity(guildId, state);
      }, CONTINUITY_HEARTBEAT_MS);
      state.continuity.timer.unref();
      this.inbox.startInboxLoop(guildId, state);
    }
    return state;
  }

  public async capture(event: ArchiveGatewayEvent): Promise<void> {
    return this.gateway.capture(event);
  }

  /**
   * Records a Gateway gap for every archived guild. A guild that fails does not stop
   * the others; its in-memory gap still forces full reconciliation in this boot.
   */
  public async markGap(reason: string): Promise<void> {
    return this.gateway.markGap(reason);
  }

  /**
   * Reduces up to `limit` inbox events; a caller during a round shares it. Returns
   * how many events the round retired.
   */
  public async drainInbox(guildId: string, limit = 100): Promise<number> {
    return this.inbox.drainInbox(guildId, limit);
  }

  public async scheduledPeriodic(guildId: string, intervalMs: number): Promise<void> {
    return this.periodicRunner.scheduled(guildId, intervalMs);
  }

  public async periodic(guildId: string, shouldContinue?: () => Promise<boolean>): Promise<void> {
    return this.periodicRunner.run(guildId, shouldContinue);
  }

  public async pollJobs(guildId: string): Promise<void> {
    return this.jobs.poll(guildId);
  }

  public cancel(): void {
    this.ctx.stoppedAt ??= Date.now();
    this.ctx.stopped = true;
    for (const [guildId, state] of this.ctx.states) {
      clearInterval(state.continuity.timer);
      this.continuity.confirmContinuity(guildId, state);
      state.signal.abort();
    }
    void this.invalidRequests.stop();
    this.ctx.scheduler.stop();
  }

  public async stop(): Promise<void> {
    const started = performance.now();
    this.cancel();
    await Promise.allSettled([...this.initializing.values()]);
    await Promise.allSettled(this.gateway.pending());
    await Promise.allSettled(
      [...this.ctx.states.values()].flatMap((state) =>
        [...state.work.pending(), state.inbox.run].filter(
          (work): work is NonNullable<typeof work> => work !== undefined,
        ),
      ),
    );
    await this.storageReporter.stop();
    await this.invalidRequests.stop();
    for (const state of this.ctx.states.values()) {
      await this.progress.close(state);
      await state.inbox.writer.stop();
      await state.writer.stop();
      // Persists the confirmation taken when capture stopped in `cancel`; the next
      // boot rescans from it.
      await this.continuity.persistContinuitySafely(state);
      await state.repos.owner.releaseOwner(ARCHIVE_PROCESS_ID);
    }
    this.ctx.durations.shutdownDrainMs += performance.now() - started;
    this.options.logger.info(
      {
        process: this.performanceSampler.stop(),
        ...archivePerformanceLog(
          this.ctx.pipelineBudget.snapshot(),
          this.ctx.telemetry.snapshot(),
          this.ctx.scheduler.snapshot(),
        ),
        durations: this.ctx.durations,
        writers: [...this.ctx.states.values()].map((state) =>
          archiveWriterPerformanceLog(
            String(state.conn.guildId),
            state.writer.snapshot(),
            state.inbox.writer.snapshot(),
          ),
        ),
      },
      'Archive worker performance',
    );
    this.ctx.telemetry.detach();
  }
}
