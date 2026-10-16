import { describe, expect, it } from 'vitest';
import { parseTempRoleConfig } from '../../../../src/handlers/commands/temp_role/config';

describe('temp role configuration', () => {
  it.each([undefined, null, {}, { unrelated: true }])(
    'defaults to three active roles when the optional block is absent: %j',
    (config) => {
      expect(parseTempRoleConfig(config)).toEqual({ maxActivePerMember: 3 });
    },
  );

  it.each([1, 3, 50])('accepts an integer cap of %i', (maxActivePerMember) => {
    expect(parseTempRoleConfig({ temp_role: { maxActivePerMember }, unrelated: true })).toEqual({
      maxActivePerMember,
    });
  });

  it.each([
    { maxActivePerMember: 0 },
    { maxActivePerMember: 51 },
    { maxActivePerMember: 1.5 },
    { maxActivePerMember: '3' },
    { maxActivePerMember: null },
    { maxActivePerMember: Number.NaN },
    { maxActivePerMember: Number.POSITIVE_INFINITY },
    {},
    null,
    [],
    { maxActivePerMember: 3, unexpected: true },
  ])('rejects a malformed temp_role block at startup: %j', (temp_role) => {
    expect(() => parseTempRoleConfig({ temp_role })).toThrow();
  });
});
