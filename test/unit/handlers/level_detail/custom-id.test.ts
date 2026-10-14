/**
 * The leaderboard writes the page buttons' ids and `level_page` reads
 * them back; a format the two disagreed about would surface as a dead
 * button rather than an error, so the round trip is asserted here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  LEVEL_PAGE_BUTTON_ID,
  decodeLevelPageCustomId,
  encodeLevelPageCustomId,
} from '../../../../src/handlers/commands/level_detail/custom-id';

describe('level page customId', () => {
  it('round-trips the invoker and page', () => {
    const target = { invokerId: '1047744170070118400', page: 37 };
    const encoded = encodeLevelPageCustomId(target);

    expect(encoded).toBe('level_page|1047744170070118400|37');
    expect(encoded.length).toBeLessThanOrEqual(100);
    expect(decodeLevelPageCustomId(encoded)).toEqual(target);
  });

  it('keeps page 0 of a disabled ◀ button decodable so the handler can clamp it', () => {
    expect(decodeLevelPageCustomId('level_page|u-1|0')).toEqual({ invokerId: 'u-1', page: 0 });
  });

  it.each([
    'level_page',
    'level_page|u-1',
    'level_page||3',
    'level_page|u-1|x',
    'level_page|u-1|-1',
    'level_page|u-1|3|extra',
    'thread_list|u-1|3',
  ])('rejects %s', (customId) => {
    expect(decodeLevelPageCustomId(customId)).toBeUndefined();
  });

  it('names an existing button handler directory', () => {
    const root = path.resolve(__dirname, '../../../../src/handlers/buttons');
    expect(fs.existsSync(path.join(root, LEVEL_PAGE_BUTTON_ID, 'index.ts'))).toBe(true);
  });
});
