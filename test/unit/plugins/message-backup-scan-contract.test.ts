import { describe, expect, it } from 'vitest';
import { archiveGapReason } from '../../../src/plugins/message-backup/runtime/scan-contract';

describe('archive gap reason', () => {
  it.each([
    ['10: Error: Service Unavailable [trace a4031bcd]', 'other'],
    ['10: Error: Missing Access [trace 00000000]', 'permission'],
    ['10: missing-view-channel', 'permission'],
    ['Archive backfill paused: storage headroom exhausted', 'capacity'],
    ['10: Error: Reaction membership changed [trace 12345678]', 'conflict'],
    ['sdk-inventory:Error: offline', 'discovery'],
  ] as const)('classifies %s as %s', (issue, reason) => {
    expect(archiveGapReason(issue)).toBe(reason);
  });
});
