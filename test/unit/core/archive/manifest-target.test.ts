import { describe, expect, it } from 'vitest';
import {
  safeArchiveOperationChanges,
  safeArchiveOperationTarget,
} from '../../../../src/core/archive/manifest-target';

describe('safe archive operation display fields', () => {
  it('allows source identifiers and bounded historical metadata without message type guesses', () => {
    const target = safeArchiveOperationTarget({
      sourceId: '12345678901234567890',
      messageId: '23456789012345678901',
      historicalName: 'recorded\nname',
      parentId: '456',
      sourceType: 11,
      content: 'private-body',
      userIds: ['secret-user'],
    });
    expect(target).toEqual({
      identity: 'known',
      channelId: '12345678901234567890',
      messageId: '23456789012345678901',
      historicalName: 'recorded name',
      parentId: '456',
      sourceType: 11,
    });
    expect(
      safeArchiveOperationTarget({
        sourceId: {},
        messageId: 'invalid',
        historicalName: null,
        sourceType: '11',
      }),
    ).toEqual({ identity: 'unknown' });
    expect(
      safeArchiveOperationTarget({ sourceId: '1', historicalName: 'same-name', type: 11 }),
    ).not.toHaveProperty('sourceType');
  });
  it('distinguishes unknown fields from explicit cursor reset and validates numeric timestamp differences', () => {
    expect(safeArchiveOperationChanges({ afterLastMessageId: '' }, 'reset-progress')).toEqual([
      { field: 'lastMessageId', before: { state: 'unknown' }, after: { state: 'unset' } },
    ]);
    expect(
      safeArchiveOperationChanges(
        { beforeTimestamp: 'private-body', afterTimestamp: Infinity },
        'repair-message-time',
      ),
    ).toEqual([{ field: 'timestamp', before: { state: 'unknown' }, after: { state: 'unknown' } }]);
    expect(
      safeArchiveOperationChanges(
        { beforeTimestamp: '123', afterTimestamp: 123 },
        'repair-message-time',
      ),
    ).toEqual([
      {
        field: 'timestamp',
        before: { state: 'value', value: 123, storageType: 'string' },
        after: { state: 'value', value: 123, storageType: 'number' },
      },
    ]);
    expect(safeArchiveOperationChanges({ content: 'private-body' }, 'unknown')).toEqual([]);
  });
});
