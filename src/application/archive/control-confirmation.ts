import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ArchiveFullBackupJob } from '../../core/archive/types';
import { ok } from '../../core/result';
import type {
  ArchiveConfirmation,
  ArchiveControlRepo,
  ArchivePanelRef,
} from '../../persistence/repositories/archive-control.repo';
import { archiveSnowflake, rejectArchiveControl, type ControlResult } from './control-shared';

const confirmationToken = z.string().regex(/^[A-Za-z0-9_-]{24}$/);
/** A confirmation is valid this long after it was shown. */
export const ARCHIVE_CONFIRMATION_TTL_MS = 5 * 60_000;
/** Approval records are kept this long (for replays), then a TTL index removes them. */
const CONFIRMATION_RETENTION_MS = 24 * 60 * 60_000;

/** The operator a confirmation is bound to, and the panel it was shown on. */
export interface ArchivePanelActor extends ArchivePanelRef {
  readonly userId: string;
}

/** Single-use full-backup start approvals bound to the operator, channel and panel. */
export class ArchiveConfirmationService {
  public constructor(
    private readonly control: ArchiveControlRepo,
    private readonly guildId: string,
  ) {}

  /** Persists a single-use start approval bound to the operator, channel and panel. */
  public async requestConfirmation(
    actor: ArchivePanelActor,
  ): Promise<{ token: string; expiresAt: number }> {
    for (const value of [actor.userId, actor.channelId, actor.messageId])
      archiveSnowflake.parse(value);
    await this.control.ensureIndexes();
    const value = randomBytes(18).toString('base64url');
    const now = Date.now();
    const expiresAt = now + ARCHIVE_CONFIRMATION_TTL_MS;
    await this.control.insertConfirmation({
      _id: value,
      guildId: this.guildId,
      ...actor,
      action: 'full-backup',
      requestId: randomUUID(),
      createdAt: now,
      expiresAt,
      purgeAt: new Date(now + CONFIRMATION_RETENTION_MS),
    });
    return { token: value, expiresAt };
  }

  private async boundConfirmation(
    value: string,
    actor: ArchivePanelActor,
    operation: string,
  ): ControlResult<ArchiveConfirmation> {
    confirmationToken.parse(value);
    const confirmation = await this.control.findConfirmation(value);
    if (confirmation === undefined)
      return rejectArchiveControl(this.guildId, 'ARCHIVE_CONFIRMATION_UNKNOWN', operation);
    if (
      confirmation.userId !== actor.userId ||
      confirmation.channelId !== actor.channelId ||
      confirmation.messageId !== actor.messageId
    )
      return rejectArchiveControl(this.guildId, 'ARCHIVE_CONFIRMATION_ACTOR', operation);
    return ok(confirmation);
  }

  /**
   * Consumes the approval and creates the full backup with a cutoff fixed now. A
   * repeated confirmation returns the job it already created.
   */
  public async confirm(
    value: string,
    actor: ArchivePanelActor,
  ): ControlResult<ArchiveFullBackupJob> {
    const bound = await this.boundConfirmation(value, actor, 'confirm');
    if (!bound.ok) return bound;
    const confirmation = bound.value;
    if (confirmation.cancelledAt !== undefined)
      return rejectArchiveControl(this.guildId, 'ARCHIVE_CONFIRMATION_EXPIRED', 'confirm');
    const control = this.control;
    await control.ensureIndexes();
    const jobId = `${this.guildId}:${confirmation.requestId}`;
    if (
      confirmation.consumedAt === undefined &&
      !(await control.consumeConfirmation(value)) &&
      !(await control.isConfirmationConsumed(value))
    )
      return rejectArchiveControl(this.guildId, 'ARCHIVE_CONFIRMATION_EXPIRED', 'confirm');
    const existing = await control.findJobById(jobId);
    if (existing !== undefined) return ok(existing);
    const now = Date.now();
    // A replay may only finish a creation interrupted within the approval window;
    // it must not recreate a job whose record was pruned since.
    if (
      confirmation.consumedAt !== undefined &&
      now - confirmation.consumedAt > ARCHIVE_CONFIRMATION_TTL_MS
    )
      return rejectArchiveControl(this.guildId, 'ARCHIVE_CONFIRMATION_EXPIRED', 'confirm');
    const job: ArchiveFullBackupJob & { _id: string } = {
      _id: jobId,
      jobId,
      requestId: confirmation.requestId,
      guildId: this.guildId,
      command: 'full-backup',
      options: { cutoff: now },
      runId: `full:${confirmation.requestId}`,
      status: 'queued',
      cancelRequested: false,
      activeSlot: 'full-backup',
      createdAt: now,
      notification: { channelId: actor.channelId, messageId: actor.messageId, view: 'progress' },
    };
    if (!(await control.insertFullBackup(job))) {
      const raced = await control.findJobById(jobId);
      return raced === undefined
        ? rejectArchiveControl(this.guildId, 'ARCHIVE_BACKUP_ACTIVE', 'confirm')
        : ok(raced);
    }
    return ok((await control.findJobById(jobId)) ?? job);
  }

  public async cancelConfirmation(value: string, actor: ArchivePanelActor): ControlResult<void> {
    const bound = await this.boundConfirmation(value, actor, 'cancelConfirmation');
    if (!bound.ok) return bound;
    await this.control.cancelConfirmation(value);
    return ok(undefined);
  }
}
