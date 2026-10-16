import {
  ARCHIVE_DEFAULT_INTERVAL_MS,
  ARCHIVE_INVALID_REQUESTS,
} from '../../../core/archive/limits';
import {
  ArchiveInvalidRequestGuard,
  type ArchiveInvalidRequestStep,
} from '../flow/invalid-request-guard';
import { asGuildId } from '../../../core/ids';
import type { NotificationRecovery } from './notification-recovery';
import type { ArchiveGuildState, ArchiveWorkerContextFor } from './worker-context';

/** Pending invalid-request notices are retried at most this often per guild. */
const NOTICE_RETRY_CHECK_MS = 60_000;
/** Minimum interval between two logs of a guild's failed notice record. */
const FAILURE_LOG_MS = 60_000;

/**
 * Keeps the archive clear of Discord's invalid-request ban (see
 * `ARCHIVE_INVALID_REQUESTS`). Every check applies the guard's background limit to
 * the shared scheduler, logs level changes, and raises each guild's debug-channel
 * notices: one warning per episode and one recovery once the count is low for a
 * whole window. Both are persisted, so a restart neither repeats the warning nor
 * forgets the recovery.
 */
export class ArchiveInvalidRequestMonitor {
  private readonly guard: ArchiveInvalidRequestGuard;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  /** Guilds whose warning of the current episode is recorded; cleared when it ends. */
  private warned = new WeakSet<ArchiveGuildState>();
  /** Guilds whose recovery is recorded since the last episode; cleared by a new one. */
  private settled = new WeakSet<ArchiveGuildState>();
  private readonly checkedAt = new WeakMap<ArchiveGuildState, number>();
  private readonly failureLoggedAt = new WeakMap<ArchiveGuildState, number>();

  public constructor(
    private readonly ctx: ArchiveWorkerContextFor<'config' | 'logger' | 'connections'>,
    private readonly notifications: Pick<NotificationRecovery, 'deliverScheduleNotice'>,
    private readonly clock: () => number = Date.now,
    private readonly checkIntervalMs: number = ARCHIVE_INVALID_REQUESTS.checkIntervalMs,
  ) {
    this.guard = new ArchiveInvalidRequestGuard(ctx.options.config.concurrency, clock());
  }

  public start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.check();
    }, this.checkIntervalMs);
    this.timer.unref();
  }

  /** Stops checking and waits for a check in progress. */
  public async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** One check; overlapping calls share the check in progress. It never rejects. */
  public check(): Promise<void> {
    this.running ??= this.checkOnce()
      .catch((error: unknown) => {
        this.ctx.options.logger.warn({ err: error }, 'Archive invalid-request check failed');
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private async checkOnce(): Promise<void> {
    const now = this.clock();
    const count = this.ctx.telemetry.invalidLast10Minutes();
    const step = this.guard.observe(count, now);
    this.ctx.scheduler.setBackgroundLimit(step.backgroundLimit);
    this.log(step, count);
    if (step.level !== 'normal' && step.previous === 'normal') this.settled = new WeakSet();
    if (step.level === 'normal' && step.previous !== 'normal') this.warned = new WeakSet();
    for (const [guildId, state] of this.ctx.states) {
      if (this.ctx.stopped) return;
      // A disabled guild database cannot record a notice; it is raised once it is back.
      if (this.ctx.options.connections.isDisabled(asGuildId(guildId)) !== undefined) continue;
      try {
        await this.notify(guildId, state, step, count, now);
      } catch (error) {
        const loggedAt = this.failureLoggedAt.get(state);
        if (loggedAt === undefined || now - loggedAt >= FAILURE_LOG_MS || now < loggedAt) {
          this.failureLoggedAt.set(state, now);
          this.ctx.options.logger.warn(
            { guildId, err: error },
            'Archive invalid-request notice not recorded',
          );
        }
      }
    }
  }

  private async notify(
    guildId: string,
    state: ArchiveGuildState,
    step: ArchiveInvalidRequestStep,
    count: number,
    now: number,
  ): Promise<void> {
    const schedule = state.archive.schedule(ARCHIVE_DEFAULT_INTERVAL_MS);
    let deliver =
      (this.checkedAt.get(state) ?? Number.NEGATIVE_INFINITY) <= now - NOTICE_RETRY_CHECK_MS;
    // A raise that failed is tried again on the next check; raising is idempotent.
    if (step.level !== 'normal' && !this.warned.has(state)) {
      const raised = await schedule.raiseInvalidRequestNotice({ kind: 'invalid-requests', count });
      this.warned.add(state);
      deliver ||= raised === 'raised';
    } else if (step.settled && !this.settled.has(state)) {
      const raised = await schedule.raiseInvalidRequestNotice({
        kind: 'invalid-requests-recovered',
      });
      // The recovery waits until its warning is delivered or abandoned, then follows it.
      if (raised !== 'waiting') this.settled.add(state);
      deliver ||= raised === 'raised';
    }
    if (!deliver) return;
    this.checkedAt.set(state, now);
    await this.notifications.deliverScheduleNotice(guildId, schedule, 'invalid-requests');
  }

  private log(step: ArchiveInvalidRequestStep, count: number): void {
    const fields = {
      invalidLast10Minutes: count,
      level: step.level,
      previousLevel: step.previous,
      backgroundLimit: step.backgroundLimit ?? null,
      warning: ARCHIVE_INVALID_REQUESTS.warning,
      critical: ARCHIVE_INVALID_REQUESTS.critical,
      recovery: ARCHIVE_INVALID_REQUESTS.recovery,
      banLimit: ARCHIVE_INVALID_REQUESTS.banLimit,
    };
    const { logger } = this.ctx.options;
    if (step.level === step.previous) return;
    if (step.level === 'critical')
      logger.error(
        fields,
        'Archive invalid Discord requests critical; one background read at a time',
      );
    else if (step.level === 'warning')
      logger.warn(
        fields,
        step.previous === 'normal'
          ? 'Archive invalid Discord requests high; slowing background reads'
          : 'Archive invalid Discord requests below critical; background reads still slowed',
      );
    else
      logger.info(fields, 'Archive invalid Discord requests recovered; restoring background reads');
  }
}
