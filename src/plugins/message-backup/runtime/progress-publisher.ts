import { randomUUID } from 'node:crypto';
import { ARCHIVE_PROCESS_ID } from '../../../infra/archive/owner';
import { ProgressNotifier } from '../flow/progress';
import type { ArchiveGuildState, ArchiveWorkerContextFor } from './worker-context';

/**
 * Publishes a running scan's progress: saved with the full backup or the periodic
 * run, and shown on a full backup's panel.
 */
export class ProgressPublisher {
  public constructor(private readonly ctx: ArchiveWorkerContextFor<'config' | 'logger'>) {}

  public async notify(
    guildId: string,
    state: ArchiveGuildState,
    jobId?: string,
    force = false,
  ): Promise<void> {
    try {
      await this.publish(guildId, state, jobId, force);
    } catch (error) {
      this.ctx.options.logger.warn(
        { guildId, jobId, err: error },
        'Archive progress publication deferred',
      );
    }
  }

  /**
   * Every ten seconds, and at once on state changes, the snapshot is saved with the
   * full backup (renewing its lease) or the periodic run. A full backup's panel is
   * edited too; periodic passes post nothing to Discord.
   */
  private async start(
    guildId: string,
    state: ArchiveGuildState,
    jobId?: string,
    scanId?: string,
  ): Promise<void> {
    clearInterval(state.publication.heartbeat);
    await state.publication.notifications?.stop();
    const generation = randomUUID();
    state.publication.scope = { generation, jobId, scanId };
    state.publication.route = undefined;
    state.publication.notifications = new ProgressNotifier(async (snapshot) => {
      if (this.ctx.stopped || state.publication.scope?.generation !== generation) return;
      try {
        if (jobId !== undefined) {
          const saved = await state.repos.jobs.saveJobProgress(
            jobId,
            ARCHIVE_PROCESS_ID,
            snapshot,
            Date.now() + 60000,
          );
          if (!saved || state.publication.scope?.generation !== generation) return;
          await this.ctx.scheduler.run(
            `notify:${guildId}:${jobId}`,
            'live',
            () => state.notifier.publish(jobId, snapshot),
            { signal: state.signal.signal },
          );
        } else if (scanId !== undefined) {
          await state.archive.periodicRuns.update(scanId, { progress: snapshot });
        }
      } catch (error) {
        this.ctx.options.logger.warn(
          { guildId, jobId, scanId, err: error },
          'Archive progress publication deferred',
        );
        throw error;
      }
    }, this.ctx.options.config.progress_interval_seconds * 1000);
    state.publication.heartbeat = setInterval(() => {
      if (state.publication.scope?.generation !== generation || this.ctx.stopped) return;
      void this.notify(guildId, state, jobId);
      if (state.publication.heartbeatWork !== undefined) return;
      state.publication.heartbeatWork = this.observeLive(state)
        .catch((error: unknown) => {
          this.ctx.options.logger.warn(
            { guildId, err: error },
            'Archive heartbeat observation deferred',
          );
        })
        .finally(() => {
          state.publication.heartbeatWork = undefined;
        });
    }, this.ctx.options.config.progress_interval_seconds * 1000);
    state.publication.heartbeat.unref();
  }

  private async observeLive(state: ArchiveGuildState): Promise<void> {
    const progress = state.progress;
    const generation = state.publication.scope?.generation;
    if (progress === undefined) return;
    const { pending, oldestObservedAt } = await state.repos.inbox.openInbox();
    if (state.publication.scope?.generation !== generation) return;
    this.ctx.durations.inboxOldestAgeMs =
      oldestObservedAt === undefined ? 0 : Math.max(0, Date.now() - oldestObservedAt);
    progress.setExtras({
      live: {
        pending,
        oldestAgeMs:
          oldestObservedAt === undefined ? 0 : Math.max(0, Date.now() - oldestObservedAt),
        windowMs: this.ctx.options.config.progress_interval_seconds * 1000,
      },
    });
    if (
      state.publication.scope?.jobId !== undefined &&
      (await state.repos.jobs.getJob(state.publication.scope.jobId))?.cancelRequested
    )
      progress.setState('cancelling');
  }

  private async publish(
    guildId: string,
    state: ArchiveGuildState,
    jobId?: string,
    force = false,
  ): Promise<void> {
    if (state.progress === undefined || this.ctx.stopped) return;
    if (state.publication.notifications === undefined)
      await this.start(guildId, state, jobId, state.progress.snapshot().scanId);
    const snapshot = state.progress.snapshot();
    const route = `${snapshot.state}:${snapshot.phase}:${snapshot.substep}`;
    await state.publication.notifications?.update(
      snapshot,
      force || state.publication.route !== route,
    );
    state.publication.route = route;
  }

  public async close(state: ArchiveGuildState, deliverFinal = false): Promise<void> {
    clearInterval(state.publication.heartbeat);
    state.publication.heartbeat = undefined;
    await state.publication.heartbeatWork;
    if (deliverFinal && state.progress !== undefined) {
      await state.publication.notifications?.update(state.progress.snapshot(), true);
      await state.publication.notifications?.drain();
    }
    await state.publication.notifications?.stop();
    state.publication.notifications = undefined;
    state.publication.scope = undefined;
    state.publication.route = undefined;
  }
}
