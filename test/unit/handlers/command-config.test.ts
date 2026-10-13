/**
 * Operator-config parsing for the handlers whose upstream endpoints and
 * location ids moved out of source.
 *
 * The block is mandatory whenever its command is enabled: there is no
 * safe default for "which recommendation service",
 * so `validateBotConfig` fails the command's registration instead of
 * letting it answer with confidently wrong data.
 */
import { describe, expect, it } from 'vitest';

import { parseRandomRestaurantConfig } from '../../../src/handlers/commands/random_restaurant/config';
import { parseUpdateRoleConfig } from '../../../src/handlers/commands/update_role/config';

describe('parseRandomRestaurantConfig', () => {
  it('reads the endpoint from the bot config', () => {
    expect(
      parseRandomRestaurantConfig({ random_restaurant: { apiUrl: 'https://example.test/x' } }),
    ).toEqual({ apiUrl: 'https://example.test/x' });
  });

  it('rejects a missing block', () => {
    expect(() => parseRandomRestaurantConfig({})).toThrow();
  });

  it('rejects a non-http URL', () => {
    expect(() =>
      parseRandomRestaurantConfig({ random_restaurant: { apiUrl: 'file:///etc/passwd' } }),
    ).toThrow();
    expect(() => parseRandomRestaurantConfig({ random_restaurant: { apiUrl: 'nope' } })).toThrow();
  });
});

describe('parseUpdateRoleConfig', () => {
  it('accepts a well-formed level_roles map', () => {
    const parsed = parseUpdateRoleConfig({
      level_roles: { level_1: 'Rookie', level_10: 'Veteran' },
    });
    expect(parsed?.level_roles).toEqual({ level_1: 'Rookie', level_10: 'Veteran' });
  });

  it('returns undefined when the block is absent', () => {
    expect(parseUpdateRoleConfig({})).toBeUndefined();
  });

  it('returns undefined for a malformed block a property check would have accepted', () => {
    // `'level_roles' in bot.config` was true for both of these, and the
    // failure then surfaced deep inside the role loop.
    expect(parseUpdateRoleConfig({ level_roles: 42 })).toBeUndefined();
    expect(parseUpdateRoleConfig({ level_roles: { not_a_level: 'Role' } })).toBeUndefined();
    expect(parseUpdateRoleConfig({ level_roles: { level_1: '' } })).toBeUndefined();
  });
});
