/**
 * Unit tests for the social-feed selection rules.
 *
 * Two tiers are pinned separately because they carry different
 * promises. The hard rules (own post, not a repost, not a reply) hold
 * whatever a subscription asks for, so each is asserted against a
 * permissive filter — a rule that only held for the default filter
 * would be a hole a user could open from a slash command. The
 * subscription filter itself gets one case per option value.
 *
 * The final block runs the `x-media-feed` fixtures through the default
 * filter, so any drift in what reaches a channel shows up there.
 */
import { describe, expect, it } from 'vitest';

import { buildFakeFeedPlatform, buildFeedPost } from '../../../fixtures/social-feed/fake-platform';
import { selectPostsToForward } from '../../../../src/plugins/social-feed/internal';
import type { SubscriptionFilter } from '../../../../src/plugins/social-feed/internal';
import type { FeedPost } from '../../../../src/infra/social-feed';

const ACCOUNT = 'someaccount';
const PHOTO = { kind: 'photo', url: 'https://cdn.invalid/a.jpg' } as const;
const VIDEO = { kind: 'video', url: 'https://cdn.invalid/a.mp4' } as const;

const { platform } = buildFakeFeedPlatform();

/** Default filter: what a subscription gets when it names no options. */
const DEFAULT_FILTER: SubscriptionFilter = { media: 'media_only' };
/** Filter that constrains nothing, for isolating the hard rules. */
const PERMISSIVE: SubscriptionFilter = { media: 'any' };

/**
 * A post that the default filter accepts, so each case states only the
 * field it is about.
 */
const post = (overrides: Partial<FeedPost> & Pick<FeedPost, 'id'>): FeedPost =>
  buildFeedPost({ authorAccount: ACCOUNT, media: [PHOTO], ...overrides });

const select = (
  posts: readonly FeedPost[],
  options: { filter?: SubscriptionFilter; lastSeenId?: string; maxPosts?: number } = {},
): readonly string[] =>
  selectPostsToForward(posts, {
    platform,
    account: ACCOUNT,
    filter: options.filter ?? DEFAULT_FILTER,
    lastSeenId: options.lastSeenId,
    maxPosts: options.maxPosts ?? 5,
  }).map((p) => p.id);

describe('selectPostsToForward — hard rules', () => {
  it('drops a repost of someone else even under the most permissive filter', () => {
    const reposted = post({ id: '10', isRepost: true, authorAccount: 'someoneelse' });
    expect(select([reposted], { filter: PERMISSIVE })).toEqual([]);
  });

  it('drops a repost even when the author still matches the followed account', () => {
    // Pins the `isRepost` guard on its own. Every other repost fixture
    // also carries a foreign author, so without this case the author
    // rule alone would keep the suite green if the repost check went.
    const selfRepost = post({ id: '10', isRepost: true, authorAccount: ACCOUNT });
    expect(select([selfRepost], { filter: PERMISSIVE })).toEqual([]);
  });

  it('drops a post authored by someone else even when it is not flagged as a repost', () => {
    // Defence in depth: if an upstream ever stops setting its repost
    // marker, the author check alone still keeps other people's posts out.
    expect(
      select([post({ id: '10', authorAccount: 'someoneelse' })], { filter: PERMISSIVE }),
    ).toEqual([]);
  });

  it('matches the account case-insensitively', () => {
    expect(select([post({ id: '10', authorAccount: 'SomeAccount' })])).toEqual(['10']);
  });

  it('drops a reply, including a self-thread continuation, under any filter', () => {
    expect(select([post({ id: '10', isReply: true })], { filter: PERMISSIVE })).toEqual([]);
  });
});

describe('selectPostsToForward — media filter', () => {
  const textOnly = post({ id: '10', media: [] });
  const photoOnly = post({ id: '11', media: [PHOTO] });
  const videoOnly = post({ id: '12', media: [VIDEO] });
  const page = [textOnly, photoOnly, videoOnly];

  it('media_only keeps every post that carries an attachment', () => {
    expect(select(page, { filter: { media: 'media_only' } })).toEqual(['11', '12']);
  });

  it('photo_only keeps photos and drops a video-only post', () => {
    expect(select(page, { filter: { media: 'photo_only' } })).toEqual(['11']);
  });

  it('video_only keeps videos and drops a photo-only post', () => {
    expect(select(page, { filter: { media: 'video_only' } })).toEqual(['12']);
  });

  it('any forwards a text-only post as well', () => {
    expect(select(page, { filter: { media: 'any' } })).toEqual(['10', '11', '12']);
  });

  it('keeps a mixed-media post under both photo_only and video_only', () => {
    const mixed = [post({ id: '20', media: [PHOTO, VIDEO] })];
    expect(select(mixed, { filter: { media: 'photo_only' } })).toEqual(['20']);
    expect(select(mixed, { filter: { media: 'video_only' } })).toEqual(['20']);
  });
});

describe('selectPostsToForward — keyword filter', () => {
  it('keeps a post whose text contains the keyword, ignoring case', () => {
    const posts = [post({ id: '10', text: 'New ALBUM out now' })];
    expect(select(posts, { filter: { media: 'media_only', keyword: 'album' } })).toEqual(['10']);
  });

  it('drops a post whose text does not contain the keyword', () => {
    const posts = [post({ id: '10', text: 'tour dates' })];
    expect(select(posts, { filter: { media: 'media_only', keyword: 'album' } })).toEqual([]);
  });

  it('treats an empty text as no match rather than as a match', () => {
    // A platform that reports no post body normalises it to ''. A
    // substring test against '' must fail closed, or a keyword
    // subscription would forward the whole timeline.
    const posts = [post({ id: '10', text: '' })];
    expect(select(posts, { filter: { media: 'media_only', keyword: 'album' } })).toEqual([]);
  });

  it('applies the keyword on top of the media rule, not instead of it', () => {
    const posts = [post({ id: '10', text: 'new album', media: [] })];
    expect(select(posts, { filter: { media: 'media_only', keyword: 'album' } })).toEqual([]);
  });
});

describe('selectPostsToForward — cursor and ordering', () => {
  it('drops posts at or below the cursor', () => {
    const posts = [post({ id: '8' }), post({ id: '9' }), post({ id: '10' })];
    expect(select(posts, { lastSeenId: '9' })).toEqual(['10']);
  });

  it('orders by the platform comparator rather than by string or array order', () => {
    // '9' sorts after '10' as a string, so a lexicographic sort would
    // put the newer post first and read backwards in the channel.
    const posts = [post({ id: '30' }), post({ id: '9' }), post({ id: '20' })];
    expect(select(posts)).toEqual(['9', '20', '30']);
  });

  it('caps at the oldest posts so the remainder survives for the next pass', () => {
    const posts = [post({ id: '30' }), post({ id: '10' }), post({ id: '20' })];
    // Taking the newest instead would step the cursor over 10 and 20.
    expect(select(posts, { maxPosts: 2 })).toEqual(['10', '20']);
  });

  it('drops an entry the platform cannot order against the cursor', () => {
    // `compareIds` answers 0 for an id it cannot parse, which must read
    // as "not newer" rather than throwing inside a background loop.
    expect(select([post({ id: 'not-a-number' }), post({ id: '10' })], { lastSeenId: '5' })).toEqual(
      ['10'],
    );
  });

  it('returns nothing for an empty page', () => {
    expect(select([])).toEqual([]);
  });
});

describe('selectPostsToForward — default filter reproduces the former x-media-feed behaviour', () => {
  // A subscription that names no filter option must forward exactly what
  // the `x-media-feed` fixtures expect.
  it('forwards an original media post', () => {
    expect(select([post({ id: '10' })])).toEqual(['10']);
  });

  it('drops a repost', () => {
    expect(select([post({ id: '10', isRepost: true, authorAccount: 'someoneelse' })])).toEqual([]);
  });

  it('drops a reply', () => {
    expect(select([post({ id: '10', isReply: true })])).toEqual([]);
  });

  it('drops a text-only post', () => {
    expect(select([post({ id: '10', media: [] })])).toEqual([]);
  });

  it('forwards a video post', () => {
    expect(select([post({ id: '10', media: [VIDEO] })])).toEqual(['10']);
  });

  it('sorts oldest-first regardless of the order the upstream returned', () => {
    const posts = [post({ id: '30' }), post({ id: '10' }), post({ id: '20' })];
    expect(select(posts)).toEqual(['10', '20', '30']);
  });
});
