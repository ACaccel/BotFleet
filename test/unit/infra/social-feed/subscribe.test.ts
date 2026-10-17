/**
 * `prepareFeedSubscription` — the validate-then-maybe-seed sequence.
 *
 * The load-bearing property is the *absence* of an upstream read on the
 * update path: re-running `/feed subscribe` is how a filter is changed,
 * so an X outage must not stand between a member and turning a keyword
 * off. A mock counter on the fake platform is the only way to see that.
 */
import { describe, expect, it, vi } from 'vitest';

import { FeedError } from '../../../../src/core/errors';
import { ok } from '../../../../src/core/result';
import { prepareFeedSubscription } from '../../../../src/infra/social-feed';
import { buildFakeFeedPlatform, buildFeedPost } from '../../../fixtures/social-feed/fake-platform';

const NOW_MS = 1_700_000_000_000;
const alwaysNew = { nowMs: NOW_MS, isNew: async (): Promise<boolean> => true };
const neverNew = { nowMs: NOW_MS, isNew: async (): Promise<boolean> => false };

describe('prepareFeedSubscription', () => {
  it('awaits target resolution before looking up or storing the canonical source', async () => {
    const fake = buildFakeFeedPlatform({
      posts: [buildFeedPost({ id: '7', createdTimestamp: 100 })],
    });
    const isNew = vi.fn(async () => true);
    const normalizeAccount = vi.fn(async () => ok('12345/42'));
    const prepared = await prepareFeedSubscription(
      { ...fake.platform, normalizeAccount },
      'single-floor-url',
      { nowMs: NOW_MS, isNew },
    );
    expect(isNew).toHaveBeenCalledWith('12345/42');
    expect(fake.fetchTimeline).toHaveBeenCalledWith('12345/42');
    expect(prepared.ok && prepared.value.account).toBe('12345/42');
  });
  it('canonicalises the handle and seeds a cursor from the newest post', async () => {
    const { platform } = buildFakeFeedPlatform({
      posts: [buildFeedPost({ id: '7', createdTimestamp: 1_700_000_500 })],
    });

    const prepared = await prepareFeedSubscription(platform, ' @SomeOne ', alwaysNew);

    expect(prepared.ok && prepared.value.account).toBe('someone');
    expect(prepared.ok && prepared.value.cursor).toEqual({
      lastSeenId: '7',
      lastSeenTimestamp: 1_700_000_500,
    });
  });

  it('anchors an empty timeline on the clock read before the request', async () => {
    const { platform } = buildFakeFeedPlatform({ posts: [] });

    const prepared = await prepareFeedSubscription(platform, 'someone', alwaysNew);

    expect(prepared.ok && prepared.value.cursor).toEqual({
      lastSeenId: platform.baselineIdAt(NOW_MS),
      lastSeenTimestamp: Math.floor(NOW_MS / 1000),
    });
  });

  it('skips the upstream entirely for a subscription that already exists', async () => {
    const { platform, fetchTimeline } = buildFakeFeedPlatform();

    const prepared = await prepareFeedSubscription(platform, '@SomeOne', neverNew);

    expect(fetchTimeline).not.toHaveBeenCalled();
    expect(prepared.ok && prepared.value.account).toBe('someone');
    // `undefined` is the signal that the stored cursor must be left alone.
    expect(prepared.ok && prepared.value.cursor).toBeUndefined();
  });

  it('asks about the canonical handle, not the raw one', async () => {
    const { platform } = buildFakeFeedPlatform();
    const isNew = vi.fn(async () => true);

    await prepareFeedSubscription(platform, '@SomeOne', { nowMs: NOW_MS, isNew });

    expect(isNew).toHaveBeenCalledWith('someone');
  });

  it('rejects an invalid handle without asking the database or the upstream', async () => {
    const { platform, fetchTimeline } = buildFakeFeedPlatform({
      invalidAccounts: new Set(['banned']),
    });
    const isNew = vi.fn(async () => true);

    const prepared = await prepareFeedSubscription(platform, 'banned', {
      nowMs: NOW_MS,
      isNew,
    });

    expect(prepared.ok).toBe(false);
    expect(!prepared.ok && prepared.error.code).toBe('FEED_INVALID_ACCOUNT');
    expect(isNew).not.toHaveBeenCalled();
    expect(fetchTimeline).not.toHaveBeenCalled();
  });

  it('returns the upstream failure unchanged so the caller can render it', async () => {
    const failWith = new FeedError({
      code: 'FEED_NOT_FOUND',
      messageKey: 'errors:feed.not_found',
      messageParams: { platform: 'Fake', account: 'someone', status: '404' },
      context: { operation: 'test' },
    });
    const { platform } = buildFakeFeedPlatform({ failWith });

    const prepared = await prepareFeedSubscription(platform, 'someone', alwaysNew);

    expect(prepared.ok).toBe(false);
    expect(!prepared.ok && prepared.error).toBe(failWith);
  });

  it('lets an `isNew` rejection through, because a database failure is not a feed failure', async () => {
    const { platform } = buildFakeFeedPlatform();
    const boom = new Error('database down');

    await expect(
      prepareFeedSubscription(platform, 'someone', {
        nowMs: NOW_MS,
        isNew: () => Promise.reject(boom),
      }),
    ).rejects.toBe(boom);
  });
});
