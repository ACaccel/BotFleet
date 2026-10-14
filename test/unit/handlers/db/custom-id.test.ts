/**
 * Pins the `/db` panel customId contract: the leading segment names the
 * handler, the token and page survive a round trip, and anything that is
 * not exactly that shape is rejected rather than half-parsed.
 */
import { describe, expect, it } from 'vitest';

import {
  DB_PAGE_BUTTON_ID,
  DB_VIEW_MENU_ID,
  decodeDbPageCustomId,
  decodeDbViewCustomId,
  encodeDbPageCustomId,
  encodeDbViewCustomId,
} from '../../../../src/handlers/commands/db-shared/custom-id';

describe('db customId contract', () => {
  it('prefixes each id with its handler directory name', () => {
    expect(encodeDbPageCustomId('abc', 3)).toBe(`${DB_PAGE_BUTTON_ID}|abc|3`);
    expect(encodeDbViewCustomId('abc')).toBe(`${DB_VIEW_MENU_ID}|abc`);
    expect([DB_PAGE_BUTTON_ID, DB_VIEW_MENU_ID]).toEqual(['db_page', 'db_view']);
  });

  it('round-trips a page id', () => {
    expect(decodeDbPageCustomId(encodeDbPageCustomId('Tok_en-9', 42))).toEqual({
      token: 'Tok_en-9',
      page: 42,
    });
  });

  it('round-trips a view id', () => {
    expect(decodeDbViewCustomId(encodeDbViewCustomId('Tok_en-9'))).toBe('Tok_en-9');
  });

  it.each([
    'db_page',
    'db_page|abc',
    'db_page||1',
    'db_page|abc|',
    'db_page|abc|-1',
    'db_page|abc|1.5',
    'db_page|abc|123456',
    'db_page|a b|1',
    `db_page|${'x'.repeat(33)}|1`,
    'db_page|abc|1|extra',
    'db_view|abc|1',
    'other|abc|1',
  ])('rejects the malformed page id %j', (customId) => {
    expect(decodeDbPageCustomId(customId)).toBeUndefined();
  });

  it.each(['db_view', 'db_view|', 'db_view|a b', `db_view|${'x'.repeat(33)}`, 'db_page|abc|1'])(
    'rejects the malformed view id %j',
    (customId) => {
      expect(decodeDbViewCustomId(customId)).toBeUndefined();
    },
  );
});
