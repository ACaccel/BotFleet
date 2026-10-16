import { describe, expect, it } from 'vitest';

import {
  parseCapacity,
  parseDeadline,
  parseStartTime,
} from '../../../../src/handlers/commands/activity-shared/parse-input';

const NOW = Date.UTC(2026, 9, 14, 0, 0);

describe('activity form input', () => {
  it('reads a start time in the bot time zone or as a duration', () => {
    expect(parseStartTime('2026-10-20 20:00', NOW, 'Asia/Taipei')).toBe(
      Date.UTC(2026, 9, 20, 12, 0),
    );
    expect(parseStartTime('2h', NOW, 'UTC')).toBe(NOW + 2 * 3_600_000);
  });

  it('rejects a start in the past, too far ahead, or malformed', () => {
    expect(parseStartTime('2026-10-01 10:00', NOW, 'UTC')).toBeNull();
    expect(parseStartTime('2028-01-01 10:00', NOW, 'UTC')).toBeNull();
    expect(parseStartTime('2026-13-01 10:00', NOW, 'UTC')).toBeNull();
    expect(parseStartTime('tomorrow', NOW, 'UTC')).toBeNull();
  });

  it('bounds the sign-up deadline to 1 minute-30 days', () => {
    expect(parseDeadline('1d', NOW)).toBe(NOW + 86_400_000);
    expect(parseDeadline('30s', NOW)).toBeNull();
    expect(parseDeadline('31d', NOW)).toBeNull();
  });

  it('treats a blank capacity as unlimited and rejects bad numbers', () => {
    expect(parseCapacity('')).toBeUndefined();
    expect(parseCapacity('12')).toBe(12);
    expect(parseCapacity('0')).toBeNull();
    expect(parseCapacity('2.5')).toBeNull();
    expect(parseCapacity('501')).toBeNull();
  });
});
