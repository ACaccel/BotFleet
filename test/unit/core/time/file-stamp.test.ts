import { describe, expect, it } from 'vitest';

import { formatFileStamp } from '../../../../src/core/time';

describe('formatFileStamp', () => {
  it('zero-pads every field and uses a colon-free separator', () => {
    expect(formatFileStamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02_03-04-05');
  });

  it('reports the 1-based month and the 24-hour clock', () => {
    expect(formatFileStamp(new Date(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31_23-59-59');
  });
});
