/** The shared bearer-token check behind the loopback HTTP APIs. */
import { describe, expect, it } from 'vitest';

import { createBearerCheck } from '../../../../src/core/http';

describe('createBearerCheck', () => {
  const check = createBearerCheck('s'.repeat(32));

  it('accepts only the configured token', () => {
    expect(check(`Bearer ${'s'.repeat(32)}`)).toBe(true);
    expect(check(`bearer ${'s'.repeat(32)} `)).toBe(true);
    expect(check(undefined)).toBe(false);
    expect(check('')).toBe(false);
    expect(check(`Bearer ${'s'.repeat(31)}`)).toBe(false);
    expect(check(`Basic ${'s'.repeat(32)}`)).toBe(false);
    expect(check('s'.repeat(32))).toBe(false);
  });
});
