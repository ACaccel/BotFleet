import { isResumableBackup, type ArchiveFullBackupJob } from '../../core/archive/types';
import { ok } from '../../core/result';
import type {
  ArchiveControlRepo,
  ArchivePanelRef,
} from '../../persistence/repositories/archive-control.repo';
import { archiveJobReference, rejectArchiveControl, type ControlResult } from './control-shared';

/** Commands on one guild's full backups: lookup, stop, resume and the panel that follows them. */
export class ArchiveJobCommands {
  public constructor(
    private readonly control: ArchiveControlRepo,
    private readonly guildId: string,
  ) {}

  /** The newest full backup in any state. */
  public async latestFullBackup(): Promise<ArchiveFullBackupJob | undefined> {
    return this.control.latestFullBackup();
  }

  public async job(jobId: string): ControlResult<ArchiveFullBackupJob> {
    archiveJobReference.parse(jobId);
    const job = await this.control.findFullBackup(jobId);
    return job === undefined
      ? rejectArchiveControl(this.guildId, 'ARCHIVE_JOB_UNKNOWN', 'job', jobId)
      : ok(job);
  }

  /**
   * Requests a cooperative stop. A queued backup stops at once; a running one
   * stops at its next safe boundary, keeping its cutoff and checkpoints.
   */
  public async stop(jobId: string): ControlResult<ArchiveFullBackupJob> {
    archiveJobReference.parse(jobId);
    await this.control.requestStop(jobId, Date.now());
    return this.job(jobId);
  }

  /** The newest full backup, if it is stopped or failed and may resume or start over. */
  private async restartable(jobId: string, operation: string): ControlResult<ArchiveFullBackupJob> {
    const found = await this.job(jobId);
    if (!found.ok) return found;
    const latest = await this.latestFullBackup();
    if (!isResumableBackup(found.value) || latest?.jobId !== found.value.jobId)
      return rejectArchiveControl(this.guildId, 'ARCHIVE_JOB_NOT_RESUMABLE', operation, jobId);
    return found;
  }

  /**
   * Queues a stopped or failed full backup again with its original cutoff and
   * checkpoints, while no other full backup is active; `panel` becomes the message
   * that follows it.
   */
  public async resume(jobId: string, panel: ArchivePanelRef): ControlResult<ArchiveFullBackupJob> {
    const restartable = await this.restartable(jobId, 'resume');
    if (!restartable.ok) return restartable;
    await this.control.ensureIndexes();
    const outcome = await this.control.requeueFullBackup(jobId, {
      ...panel,
      view: 'progress',
    });
    if (outcome === 'not-resumable')
      return rejectArchiveControl(this.guildId, 'ARCHIVE_JOB_NOT_RESUMABLE', 'resume', jobId);
    if (outcome === 'slot-taken')
      return rejectArchiveControl(this.guildId, 'ARCHIVE_BACKUP_ACTIVE', 'resume', jobId);
    return this.job(jobId);
  }

  /**
   * Prepares starting over from the newest stopped or failed backup: the panel is
   * detached from it, so its result cannot later overwrite the new confirmation.
   */
  public async prepareRestart(jobId: string, panel: ArchivePanelRef): ControlResult<void> {
    const restartable = await this.restartable(jobId, 'prepareRestart');
    if (!restartable.ok) return restartable;
    await this.releasePanel(restartable.value.jobId, panel.messageId);
    return ok(undefined);
  }

  /** Moves the panel that follows a full backup, or switches its page. */
  public async setPanel(
    jobId: string,
    panel: ArchivePanelRef & { view: 'progress' | 'gaps' },
  ): Promise<void> {
    archiveJobReference.parse(jobId);
    await this.control.setPanel(jobId, panel);
  }

  /** Detaches a finished backup from a panel that now shows something else. */
  public async releasePanel(jobId: string, messageId: string): Promise<void> {
    archiveJobReference.parse(jobId);
    await this.control.releasePanel(jobId, messageId);
  }
}
