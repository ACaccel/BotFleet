import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_PERIODIC_RETRY_DELAY_MS,
  archiveRetryDelay,
  type ArchivePassOutcome,
} from '../../../../src/core/archive/schedule';

const minute = ARCHIVE_PERIODIC_RETRY_DELAY_MS;

describe('archive pass retry delay', () => {
  it.each<[ArchivePassOutcome, number | undefined]>([
    [{ kind: 'complete' }, undefined],
    [{ kind: 'partial' }, undefined],
    [{ kind: 'interrupted' }, minute],
    [{ kind: 'skipped' }, minute],
    [{ kind: 'failed', consecutiveFailures: 1 }, minute],
    [{ kind: 'failed', consecutiveFailures: 2 }, minute * 2],
    [{ kind: 'failed', consecutiveFailures: 4 }, minute * 8],
  ])('maps %o to %s ms (undefined waits the interval)', (outcome, delay) => {
    expect(archiveRetryDelay(outcome)).toBe(delay);
  });

  it('bounds the backoff exponent so the delay stays a safe integer', () => {
    const delay = archiveRetryDelay({ kind: 'failed', consecutiveFailures: 10_000 });
    expect(Number.isSafeInteger(delay)).toBe(true);
    expect(delay).toBe(minute * 2 ** 14);
    // The cap exceeds the one-week interval limit, so `finish` always clamps it.
    expect(delay).toBeGreaterThan(604_800_000);
    expect(archiveRetryDelay({ kind: 'failed', consecutiveFailures: 0 })).toBe(minute);
  });
});
