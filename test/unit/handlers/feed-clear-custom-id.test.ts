/**
 * The customId contract between `/feed unsubscribe`'s prompt and the
 * buttons that answer it.
 *
 * Encoding and decoding are joined only by a string format, and a
 * mismatch would surface as a button nobody answers rather than as an
 * error — so the round trip is asserted here rather than left to the
 * two handler suites.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  FEED_CLEAR_CANCEL_ID,
  FEED_CLEAR_CONFIRM_ID,
  decodeFeedClearCustomId,
  encodeFeedClearCustomId,
} from '../../../src/handlers/feed-clear-custom-id';

const scope = { channelId: 'chan-1', invokerId: 'u-1' } as const;

describe('feed clear customId', () => {
  it('round-trips the scope through both handler ids', () => {
    for (const handler of [FEED_CLEAR_CONFIRM_ID, FEED_CLEAR_CANCEL_ID] as const) {
      expect(decodeFeedClearCustomId(encodeFeedClearCustomId(handler, scope))).toEqual(scope);
    }
  });

  it('puts the handler name first, which is what the dispatcher reads', () => {
    // `createCustomIdDispatcher` selects the handler by the leading
    // segment, so the id and the handler directory name are one thing.
    const encoded = encodeFeedClearCustomId(FEED_CLEAR_CONFIRM_ID, scope);

    expect(encoded.split('|')[0]).toBe('feed_clear_confirm');
    expect(encoded.length).toBeLessThanOrEqual(100);
  });

  it('rejects an id carrying no scope', () => {
    // Another bot's component, or one written by an older deployment.
    expect(decodeFeedClearCustomId('feed_clear_confirm')).toBeUndefined();
    expect(decodeFeedClearCustomId('feed_clear_confirm|chan-1')).toBeUndefined();
  });

  it('rejects an id with an empty segment rather than guessing', () => {
    expect(decodeFeedClearCustomId('feed_clear_confirm||u-1')).toBeUndefined();
    expect(decodeFeedClearCustomId('feed_clear_confirm|chan-1|')).toBeUndefined();
  });

  it('names handlers that exist as button handler directories', () => {
    // The generated registry is keyed by directory name and the
    // dispatcher resolves the leading segment against it, so a renamed
    // handler directory must fail here rather than as a dead button.
    // Checked on disk instead of through the registry module, whose
    // eager imports trip the handler factory outside the barrel.
    const buttonsRoot = path.resolve(__dirname, '../../../src/handlers/buttons');
    for (const id of [FEED_CLEAR_CONFIRM_ID, FEED_CLEAR_CANCEL_ID]) {
      expect(fs.existsSync(path.join(buttonsRoot, id, 'index.ts'))).toBe(true);
    }
  });

  it('rejects an id with a fourth segment rather than reading a prefix of it', () => {
    expect(decodeFeedClearCustomId('feed_clear_confirm|chan-1|u-1|extra')).toBeUndefined();
  });

  it('stays inside the customId limit with real snowflake ids', () => {
    const snowflakes = { channelId: '1047744170070118400', invokerId: '9999999999999999999' };
    expect(encodeFeedClearCustomId(FEED_CLEAR_CONFIRM_ID, snowflakes).length).toBeLessThanOrEqual(
      100,
    );
  });
});
