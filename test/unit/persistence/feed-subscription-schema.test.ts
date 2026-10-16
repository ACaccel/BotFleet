/**
 * Guards for the two compile-time claims the feed-subscription schema
 * makes, plus the runtime guard that enforces them at the read boundary.
 *
 * The type assertions are the canary for `FEED_MEDIA_FILTERS`'s
 * `as const`: without it the tuple widens to `string[]`, `FeedMediaFilter`
 * silently becomes `string`, the inferred document type widens with it —
 * and every consumer still compiles. Nothing else in the suite would
 * turn red.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  DEFAULT_FEED_MEDIA_FILTER,
  FEED_MEDIA_FILTERS,
  isFeedMediaFilter,
  type FeedMediaFilter,
  type FeedSubscriptionDoc,
} from '../../../src/persistence/schemas/feed-subscription.schema';

describe('feed-subscription schema types', () => {
  it('keeps FeedMediaFilter a literal union rather than string', () => {
    expectTypeOf<FeedMediaFilter>().toEqualTypeOf<
      'media_only' | 'photo_only' | 'video_only' | 'any'
    >();
    expectTypeOf<FeedMediaFilter>().not.toEqualTypeOf<string>();
  });

  it('carries that union onto the inferred document', () => {
    expectTypeOf<FeedSubscriptionDoc['filter']['media']>().toEqualTypeOf<FeedMediaFilter>();
  });

  it('exposes the default as a literal, so a command can use it as a choice', () => {
    expectTypeOf(DEFAULT_FEED_MEDIA_FILTER).toEqualTypeOf<'media_only'>();
    expect(FEED_MEDIA_FILTERS).toContain(DEFAULT_FEED_MEDIA_FILTER);
  });

  it('models an unset cursor as undefined only, never null', () => {
    expectTypeOf<FeedSubscriptionDoc['last_seen_id']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<FeedSubscriptionDoc['last_seen_timestamp']>().toEqualTypeOf<number | undefined>();
  });
});

describe('isFeedMediaFilter', () => {
  it.each(FEED_MEDIA_FILTERS)('accepts the stored value %s', (value) => {
    expect(isFeedMediaFilter(value)).toBe(true);
  });

  it.each([
    ['a filter this build does not know', 'images_only'],
    ['an empty string', ''],
    ['a non-string', 42],
    ['null', null],
    ['undefined', undefined],
    ['an object', { media: 'any' }],
  ])('rejects %s', (_label, value) => {
    expect(isFeedMediaFilter(value)).toBe(false);
  });

  it('narrows the value for the caller', () => {
    const stored: unknown = 'video_only';
    if (isFeedMediaFilter(stored)) {
      expectTypeOf(stored).toEqualTypeOf<FeedMediaFilter>();
      expect(stored).toBe('video_only');
    } else {
      expect.unreachable('video_only is a known media filter');
    }
  });
});
