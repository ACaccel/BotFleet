/**
 * `/feed subscribe`'s filter assembly.
 *
 * The two options are the only user input stored verbatim, so this pins
 * the decisions the handler cannot re-litigate later: what "not given"
 * means, what the default is, and which keywords are refused instead of
 * stored.
 */
import { describe, expect, it } from 'vitest';

import { buildSubscriptionFilter } from '../../../../src/handlers/commands/feed_subscribe/build-filter';
import { MAX_FEED_KEYWORD_LENGTH } from '../../../../src/infra/social-feed';
import { FEED_MEDIA_FILTERS } from '../../../../src/persistence/schemas/feed-subscription.schema';

/** The stored filter, failing the test when the keyword was refused. */
const built = (media: string | undefined, keyword: string | undefined) => {
  const result = buildSubscriptionFilter(media, keyword);
  if (result.kind !== 'filter') throw new Error(`refused: ${JSON.stringify(result.refusal)}`);
  return result.filter;
};

describe('buildSubscriptionFilter', () => {
  it('defaults to media-only and omits keyword entirely when nothing is given', () => {
    const filter = built(undefined, undefined);

    expect(filter).toEqual({ media: 'media_only' });
    // Not merely undefined: the repository replaces the stored filter
    // wholesale, and an explicit `keyword: undefined` would travel into
    // the `$set` document as a null field.
    expect('keyword' in filter).toBe(false);
  });

  it.each(FEED_MEDIA_FILTERS)('reflects the %s media choice', (media) => {
    expect(built(media, undefined).media).toBe(media);
  });

  it('keeps a supplied keyword', () => {
    expect(built(undefined, 'live')).toEqual({ media: 'media_only', keyword: 'live' });
  });

  it('trims a keyword before storing it', () => {
    expect(built(undefined, '  live  ').keyword).toBe('live');
  });

  it('stores a keyword expression exactly as typed', () => {
    expect(built(undefined, 'live OR (album AND tour)').keyword).toBe('live OR (album AND tour)');
  });

  it.each(['', '   ', '\n\t'])('treats the blank keyword %j as not given', (keyword) => {
    expect('keyword' in built(undefined, keyword)).toBe(false);
  });

  it('measures the limit after trimming, so padding does not count', () => {
    const keyword = `   ${'a'.repeat(MAX_FEED_KEYWORD_LENGTH)}   `;

    expect(built(undefined, keyword).keyword).toBe('a'.repeat(MAX_FEED_KEYWORD_LENGTH));
  });

  it('refuses an over-long keyword rather than truncating it', () => {
    // Truncation could cut an expression mid-operand or drop a closing
    // parenthesis, storing a filter the member never wrote.
    expect(buildSubscriptionFilter(undefined, 'a'.repeat(MAX_FEED_KEYWORD_LENGTH + 1))).toEqual({
      kind: 'refused',
      refusal: ['replies:feed.keyword_too_long', { max: MAX_FEED_KEYWORD_LENGTH }],
    });
  });

  it('refuses a malformed keyword expression', () => {
    expect(buildSubscriptionFilter(undefined, 'live AND')).toEqual({
      kind: 'refused',
      refusal: ['replies:feed.keyword_invalid'],
    });
  });

  it('falls back to the default for a media value outside the known set', () => {
    // Discord constrains this to the declared choices, so reaching here
    // means the handler's `setConfig` and the schema have drifted apart.
    expect(built('gif_only', undefined).media).toBe('media_only');
  });
});
