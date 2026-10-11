import { archiveJobProgress } from '../../../core/archive/progress';
import type { ArchiveFullBackupJob } from '../../../core/archive/types';
import type { ArchiveScheduleRepo } from '../../../persistence/repositories/archive-schedule.repo';
import { deliverArchiveScheduleNotice } from './backup-notifier';
import type { ArchiveGuildState, ArchiveWorkerContextFor } from './worker-context';

/** Later retries of an unsaved terminal state, and of a failed result edit, back off to five minutes. */
const DEFERRED_RETRY_BASE_MS = 5000;
const DEFERRED_RETRY_MAX_MS = 300_000;
/** A result edit that keeps failing is abandoned after this many attempts. */
const RESULT_DELIVERY_ATTEMPTS = 20;
export const deferredRetryDelay = (attempts: number): number =>
  Math.min(DEFERRED_RETRY_MAX_MS, DEFERRED_RETRY_BASE_MS * 2 ** Math.min(attempts, 6));

/**
 * Delivers results and notices that must reach Discord eventually: a finished full
 * backup's panel result and the schedule's failing and recovered notices.
 */
export class NotificationRecovery {
  public constructor(
    private readonly ctx: ArchiveWorkerContextFor<'logger' | 'registry' | 'translator'>,
  ) {}

  /**
   * Shows a finished full backup's result on its panel. A failed edit is retried on
   * later polls, backing off from five seconds to five minutes, and abandoned after
   * twenty attempts; a panel Discord refuses permanently is detached at once.
   */
  public async publishBackupResult(
    guildId: string,
    state: ArchiveGuildState,
    job: ArchiveFullBackupJob,
  ): Promise<void> {
    try {
      const delivery = await this.ctx.scheduler.run(
        `notify:${guildId}:${job.jobId}`,
        'live',
        () => state.notifier.publish(job.jobId, archiveJobProgress(job)),
        { signal: state.signal.signal },
      );
      if (delivery === 'released')
        this.ctx.options.logger.warn(
          { guildId, jobId: job.jobId },
          'Archive panel unavailable; result kept for /archive status',
        );
    } catch (error) {
      const attempts = (job.notification?.attempts ?? 0) + 1;
      const abandoned = attempts >= RESULT_DELIVERY_ATTEMPTS;
      this.ctx.options.logger.warn(
        { guildId, jobId: job.jobId, attempts, err: error },
        abandoned
          ? 'Archive result notification abandoned'
          : 'Archive result notification deferred',
      );
      await (
        abandoned
          ? state.repos.jobs.abandonBackupNotification(job.jobId)
          : state.repos.jobs.deferBackupNotification(
              job.jobId,
              attempts,
              Date.now() + deferredRetryDelay(attempts),
            )
      ).catch((saveError: unknown) => {
        this.ctx.options.logger.warn(
          { guildId, jobId: job.jobId, err: saveError },
          'Archive notification retry could not be saved',
        );
      });
    }
  }

  public async retryBackupResults(guildId: string, state: ArchiveGuildState): Promise<void> {
    const now = Date.now();
    const jobs = await state.repos.jobs.undeliveredBackupResults(now, 3);
    for (const job of jobs) await this.publishBackupResult(guildId, state, job);
  }

  /** Failing and recovered notices go to the debug channel once; failures are retried. */
  public async deliverScheduleNotice(
    guildId: string,
    schedule: ArchiveScheduleRepo,
  ): Promise<void> {
    if (this.ctx.stopped) return;
    const channel = this.ctx.options.registry.getChannel(guildId, 'debug');
    try {
      const delivery = await deliverArchiveScheduleNotice(
        schedule,
        channel !== undefined && channel.isSendable() ? channel : undefined,
        this.ctx.options.translator,
      );
      if (delivery.kind === 'deferred')
        this.ctx.options.logger.warn(
          { guildId, retryAt: delivery.retryAt, err: delivery.error },
          'Archive schedule notice deferred',
        );
      else if (delivery.kind === 'abandoned')
        this.ctx.options.logger.error(
          { guildId, err: delivery.error },
          'Archive schedule notice refused by Discord; not retried',
        );
    } catch (error) {
      this.ctx.options.logger.warn({ guildId, err: error }, 'Archive schedule notice not recorded');
    }
  }
}
