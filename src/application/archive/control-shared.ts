import { z } from 'zod';
import { ARCHIVE_JOB_ID_PATTERN } from '../../core/archive/limits';
import { ArchiveControlError, type ArchiveControlErrorCode } from '../../core/errors';
import { err, type Err, type Result } from '../../core/result';
import type { ArchiveRepos } from '../../persistence/repositories/archive-repos';
import type { ArchiveScheduleRepo } from '../../persistence/repositories/archive-schedule.repo';

export const archiveSnowflake = z.string().regex(/^\d{1,20}$/);
export const archiveJobReference = z.string().regex(ARCHIVE_JOB_ID_PATTERN);

/** Repositories one guild's archive control reads and writes. */
export type ArchiveControlStores = Omit<ArchiveRepos, 'schedule'> & {
  readonly schedule: ArchiveScheduleRepo;
};

/** A control use case: expected rejections are values, unexpected faults throw. */
export type ControlResult<T> = Promise<Result<T, ArchiveControlError>>;

/** An expected rejection of an `ArchiveControlService` operation. */
export const rejectArchiveControl = (
  guildId: string,
  code: ArchiveControlErrorCode,
  operation: string,
  jobId?: string,
): Err<ArchiveControlError> =>
  err(
    new ArchiveControlError(code, {
      operation: `ArchiveControlService.${operation}`,
      input: { guildId, ...(jobId === undefined ? {} : { jobId }) },
    }),
  );
