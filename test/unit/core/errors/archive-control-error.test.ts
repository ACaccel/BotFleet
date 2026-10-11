import { describe, expect, it } from 'vitest';
import {
  ArchiveAccessError,
  ArchiveControlError,
  ArchiveInputError,
  DomainError,
  type ArchiveControlErrorCode,
} from '../../../../src/core/errors';

describe('archive control errors', () => {
  it.each<[ArchiveControlErrorCode, string]>([
    ['ARCHIVE_CONFIRMATION_UNKNOWN', 'replies:archive.navigation_stale'],
    ['ARCHIVE_CONFIRMATION_ACTOR', 'replies:archive.confirm_actor'],
    ['ARCHIVE_CONFIRMATION_EXPIRED', 'replies:archive.confirm_expired'],
    ['ARCHIVE_BACKUP_ACTIVE', 'replies:archive.backup_active'],
    ['ARCHIVE_JOB_UNKNOWN', 'replies:archive.navigation_stale'],
    ['ARCHIVE_JOB_NOT_RESUMABLE', 'replies:archive.backup_not_resumable'],
  ])('answers %s with %s', (code, messageKey) => {
    const error = new ArchiveControlError(code, { operation: 'ArchiveControlService.confirm' });
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ name: 'ArchiveControlError', code, messageKey });
    expect(error.context.operation).toBe('ArchiveControlService.confirm');
  });

  it('carries the access reply and its parameters', () => {
    const error = new ArchiveAccessError('errors:db.guild_disabled', { traceId: 'abc' });
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({
      code: 'ARCHIVE_ACCESS_DENIED',
      messageKey: 'errors:db.guild_disabled',
      messageParams: { traceId: 'abc' },
    });
    expect(new ArchiveAccessError('replies:archive.debug_only').messageParams).toBeUndefined();
  });

  it('marks invalid or stale input', () => {
    expect(new ArchiveInputError('replies:archive.invalid_interval')).toMatchObject({
      name: 'ArchiveInputError',
      code: 'ARCHIVE_INPUT_INVALID',
      messageKey: 'replies:archive.invalid_interval',
    });
  });
});
