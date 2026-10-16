/**
 * Unit tests for the shared baseline rule. Driven through the fake
 * platform so the rule is pinned as platform-neutral: it must reach for
 * `compareIds` and `baselineIdAt` rather than assume snowflakes.
 */
import { describe, expect, it } from 'vitest';

import {
  newestPostForBaseline,
  resolveBaselineCursor,
  type FeedBaselineCursor,
} from '../../../../src/infra/social-feed';
import { buildFakeFeedPlatform, buildFeedPost } from '../../../fixtures/social-feed/fake-platform';

const NOW_MS = 1_700_000_500_700;

describe('newestPostForBaseline', () => {
  it('picks the highest id regardless of page order', () => {
    const { platform } = buildFakeFeedPlatform();
    const posts = [
      buildFeedPost({ id: '3' }),
      buildFeedPost({ id: '9' }),
      buildFeedPost({ id: '5' }),
    ];

    expect(newestPostForBaseline(platform, posts)?.id).toBe('9');
  });

  it('counts reposts and replies, not only posts by the account itself', () => {
    // Restricting to own posts would leave a repost-only page with no
    // cursor, and the next pass would eat the first real post as its
    // baseline instead of forwarding it.
    const { platform } = buildFakeFeedPlatform();
    const posts = [
      buildFeedPost({ id: '2' }),
      buildFeedPost({ id: '11', isRepost: true, authorAccount: 'otheraccount' }),
      buildFeedPost({ id: '5', isReply: true }),
    ];

    expect(newestPostForBaseline(platform, posts)?.id).toBe('11');
  });

  it('leaves the caller array in its original order', () => {
    const { platform } = buildFakeFeedPlatform();
    const posts = [buildFeedPost({ id: '3' }), buildFeedPost({ id: '1' })];

    newestPostForBaseline(platform, posts);

    expect(posts.map((p) => p.id)).toEqual(['3', '1']);
  });

  it.each([
    ['leading', ['not-a-number', '10']],
    ['trailing', ['10', 'not-a-number']],
  ])('declines to anchor on a page holding a %s unorderable id', (_position, ids) => {
    // `compareIds` answers 0 for an id it cannot read, so no entry on
    // this page strictly beats the others. Returning either one would
    // seed a cursor nothing can later compare against, which kills the
    // subscription silently; `undefined` sends the caller to the clock.
    const { platform } = buildFakeFeedPlatform();
    const posts = ids.map((id) => buildFeedPost({ id }));

    expect(newestPostForBaseline(platform, posts)).toBeUndefined();
  });

  it('anchors normally once every id on the page is orderable', () => {
    const { platform } = buildFakeFeedPlatform();
    const posts = [buildFeedPost({ id: '10' }), buildFeedPost({ id: '9' })];

    expect(newestPostForBaseline(platform, posts)?.id).toBe('10');
  });

  it('returns undefined for an empty page', () => {
    expect(newestPostForBaseline(buildFakeFeedPlatform().platform, [])).toBeUndefined();
  });
});

describe('resolveBaselineCursor', () => {
  it('anchors on the newest post when the page has one', () => {
    const { platform } = buildFakeFeedPlatform();
    const posts = [
      buildFeedPost({ id: '4', createdTimestamp: 1_699_999_000 }),
      buildFeedPost({ id: '12', createdTimestamp: 1_700_000_000 }),
    ];

    const cursor: FeedBaselineCursor = resolveBaselineCursor(platform, posts, NOW_MS);

    expect(cursor).toEqual({ lastSeenId: '12', lastSeenTimestamp: 1_700_000_000 });
  });

  it('falls back to the clock when the page cannot be ordered', () => {
    // Safe direction: a clock floor still suppresses the backfill, while
    // an unorderable cursor would stall the feed forever.
    const { platform } = buildFakeFeedPlatform();
    const posts = [buildFeedPost({ id: 'not-a-number' }), buildFeedPost({ id: '10' })];

    expect(resolveBaselineCursor(platform, posts, NOW_MS)).toEqual({
      lastSeenId: String(NOW_MS),
      lastSeenTimestamp: 1_700_000_500,
    });
  });

  it('falls back to the platform id floor and the clock on an empty page', () => {
    // A `'0'` anchor would make the next full sweep replay the whole
    // back catalogue; the platform-derived floor is what prevents it.
    const { platform } = buildFakeFeedPlatform();

    const cursor: FeedBaselineCursor = resolveBaselineCursor(platform, [], NOW_MS);

    // Floor, not round: NOW_MS carries 700 ms, so rounding would report
    // the next second and place the cursor slightly in the future.
    expect(cursor).toEqual({ lastSeenId: String(NOW_MS), lastSeenTimestamp: 1_700_000_500 });
  });
});
