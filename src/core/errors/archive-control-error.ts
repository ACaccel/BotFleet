/**
 * Expected rejections of Discord archive control.
 *
 * `ArchiveControlError` is the error channel of the archive control use cases:
 * they return `Result<T, ArchiveControlError>` for a stale, foreign or conflicting
 * request and throw only for unexpected faults. `ArchiveAccessError` and
 * `ArchiveInputError` are raised by the `/archive` interaction boundary itself
 * (access gate, option and custom-ID validation). The archive handlers answer all
 * three privately with `messageKey`; none is logged as a failure.
 */
import { DomainError } from './domain-error';
import type { ErrorContext } from './error-context';

/** Why archive control refused a request. */
export type ArchiveControlErrorCode =
  | 'ARCHIVE_CONFIRMATION_UNKNOWN'
  | 'ARCHIVE_CONFIRMATION_ACTOR'
  | 'ARCHIVE_CONFIRMATION_EXPIRED'
  | 'ARCHIVE_BACKUP_ACTIVE'
  | 'ARCHIVE_JOB_UNKNOWN'
  | 'ARCHIVE_JOB_NOT_RESUMABLE';

const CONTROL_KEYS: Readonly<Record<ArchiveControlErrorCode, string>> = {
  ARCHIVE_CONFIRMATION_UNKNOWN: 'replies:archive.navigation_stale',
  ARCHIVE_CONFIRMATION_ACTOR: 'replies:archive.confirm_actor',
  ARCHIVE_CONFIRMATION_EXPIRED: 'replies:archive.confirm_expired',
  ARCHIVE_BACKUP_ACTIVE: 'replies:archive.backup_active',
  ARCHIVE_JOB_UNKNOWN: 'replies:archive.navigation_stale',
  ARCHIVE_JOB_NOT_RESUMABLE: 'replies:archive.backup_not_resumable',
};

export class ArchiveControlError extends DomainError<ArchiveControlErrorCode> {
  public constructor(code: ArchiveControlErrorCode, context: ErrorContext) {
    super({ code, messageKey: CONTROL_KEYS[code], context });
  }
}

type ArchiveReplyParams = Readonly<Record<string, string | number>> | undefined;

/** The operator may not use archive controls here; `messageKey` is the private reply. */
export class ArchiveAccessError extends DomainError<'ARCHIVE_ACCESS_DENIED', ArchiveReplyParams> {
  public constructor(
    messageKey: string,
    messageParams?: Readonly<Record<string, string | number>>,
  ) {
    super({
      code: 'ARCHIVE_ACCESS_DENIED',
      messageKey,
      context: { operation: 'requireArchiveAccess' },
      ...(messageParams === undefined ? {} : { messageParams }),
    });
  }
}

/** The request itself is invalid or out of date (an option value, a stale button). */
export class ArchiveInputError extends DomainError<'ARCHIVE_INPUT_INVALID'> {
  public constructor(messageKey: string) {
    super({
      code: 'ARCHIVE_INPUT_INVALID',
      messageKey,
      context: { operation: 'archiveInteraction' },
    });
  }
}
