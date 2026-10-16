/**
 * `/feed subscribe`'s filter assembly.
 *
 * The two options are the only user input stored verbatim, so this pins
 * the three decisions the handler cannot re-litigate later: what "not
 * given" means, what the default is, and what happens to a keyword the
 * schema would refuse.
 */
import { describe, expect, it } from 'vitest';

import { buildSubscriptionFilter } from '../../../../src/handlers/commands/feed_subscribe/build-filter';
import { FEED_MEDIA_FILTERS } from '../../../../src/persistence/schemas/feed-subscription.schema';

describe('buildSubscriptionFilter', () => {
  it('defaults to media-only and omits keyword entirely when nothing is given', () => {
    const filter = buildSubscriptionFilter(undefined, undefined);

    expect(filter).toEqual({ media: 'media_only' });
    // Not merely undefined: the repository replaces the stored filter
    // wholesale, and an explicit `keyword: undefined` would travel into
    // the `$set` document as a null field.
    expect('keyword' in filter).toBe(false);
  });

  it.each(FEED_MEDIA_FILTERS)('reflects the %s media choice', (media) => {
    expect(buildSubscriptionFilter(media, undefined).media).toBe(media);
  });

  it('keeps a supplied keyword', () => {
    expect(buildSubscriptionFilter(undefined, 'live')).toEqual({
      media: 'media_only',
      keyword: 'live',
    });
  });

  it('trims a keyword before storing it', () => {
    expect(buildSubscriptionFilter(undefined, '  live  ').keyword).toBe('live');
  });

  it.each(['', '   ', '\n\t'])('treats the blank keyword %j as not given', (keyword) => {
    expect('keyword' in buildSubscriptionFilter(undefined, keyword)).toBe(false);
  });

  it('trims before truncating, so leading blanks do not eat the limit', () => {
    // Padding on both sides distinguishes `trim().slice()` from
    // `slice().trim()`, which differ by the width of the padding.
    const keyword = buildSubscriptionFilter(undefined, `   ${'a'.repeat(150)}   `).keyword;

    expect(keyword).toBe('a'.repeat(100));
  });

  it('falls back to the default for a media value outside the known set', () => {
    // Discord constrains this to the declared choices, so reaching here
    // means the handler's `setConfig` and the schema have drifted apart.
    expect(buildSubscriptionFilter('gif_only', undefined).media).toBe('media_only');
  });
});
