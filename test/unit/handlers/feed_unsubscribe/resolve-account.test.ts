/**
 * `/feed unsubscribe`'s account resolution.
 *
 * The deletion scope has to spell every account exactly the way
 * `/feed subscribe` stored it, and the command's `platform` option is
 * optional — so this covers both the platform-informed path and the
 * best-effort fallback that stands in for it, over a list rather than a
 * single handle.
 */
import { describe, expect, it, vi } from 'vitest';

import { resolveUnsubscribeAccounts } from '../../../../src/handlers/commands/feed_unsubscribe/resolve-account';
import { normalizeBahamutTargetOffline } from '../../../../src/infra/social-feed';
import type * as SocialFeed from '../../../../src/infra/social-feed';
import { FeedError } from '../../../../src/core/errors';
import { err, ok } from '../../../../src/core/result';
import { buildFakeFeedPlatform } from '../../../fixtures/social-feed/fake-platform';

vi.mock('../../../../src/infra/social-feed', async (importOriginal) => ({
  ...(await importOriginal<typeof SocialFeed>()),
  normalizeBahamutTargetOffline: vi.fn(),
}));

const { platform } = buildFakeFeedPlatform({ invalidAccounts: new Set(['banned']) });

describe('resolveUnsubscribeAccounts', () => {
  it('awaits a configured asynchronous resolver', async () => {
    const normalizeAccount = vi.fn(async () => ok('36476/3047'));
    const resolved = await resolveUnsubscribeAccounts({ ...platform, normalizeAccount }, [
      'a-public-floor-link',
    ]);
    expect(resolved).toEqual(ok(['36476/3047']));
    expect(normalizeAccount).toHaveBeenCalledWith('a-public-floor-link');
  });

  it('uses the offline normalizer for a disabled Bahamut platform', async () => {
    vi.mocked(normalizeBahamutTargetOffline).mockReturnValueOnce(ok('board:36476'));
    expect(await resolveUnsubscribeAccounts(undefined, ['a-public-board-link'], 'bahamut')).toEqual(
      ok(['board:36476']),
    );
    expect(normalizeBahamutTargetOffline).toHaveBeenLastCalledWith('a-public-board-link');
  });

  it('removes stored Bahamut IDs without calling a configured upstream resolver', async () => {
    const normalizeAccount = vi.fn(async () => ok('wrong-thread'));
    vi.mocked(normalizeBahamutTargetOffline)
      .mockReturnValueOnce(ok('board:36476'))
      .mockReturnValueOnce(ok('36476/3047'));
    expect(
      await resolveUnsubscribeAccounts(
        { ...platform, id: 'bahamut', normalizeAccount },
        ['board:36476', '36476/3047'],
        'bahamut',
      ),
    ).toEqual(ok(['board:36476', '36476/3047']));
    expect(normalizeAccount).not.toHaveBeenCalled();
  });

  it('resolves floor links through the configured Promise normalizer', async () => {
    const failure = new FeedError({
      code: 'FEED_INVALID_ACCOUNT',
      messageKey: 'errors:feed.bahamut_resolution_required',
      messageParams: { platform: 'Bahamut' },
      context: { operation: 'test' },
    });
    vi.mocked(normalizeBahamutTargetOffline).mockReturnValueOnce(err(failure));
    const normalizeAccount = vi.fn(async () => ok('36476/3047'));
    expect(
      await resolveUnsubscribeAccounts(
        { ...platform, id: 'bahamut', normalizeAccount },
        ['a-public-floor-link'],
        'bahamut',
      ),
    ).toEqual(ok(['36476/3047']));
    expect(normalizeAccount).toHaveBeenCalledWith('a-public-floor-link');
  });

  it('fails the whole scope when an offline floor link needs a resolver', async () => {
    const failure = new FeedError({
      code: 'FEED_INVALID_ACCOUNT',
      messageKey: 'errors:feed.bahamut_resolution_required',
      messageParams: { platform: 'Bahamut' },
      context: { operation: 'test' },
    });
    vi.mocked(normalizeBahamutTargetOffline)
      .mockReturnValueOnce(ok('board:36476'))
      .mockReturnValueOnce(err(failure));
    expect(
      await resolveUnsubscribeAccounts(
        undefined,
        ['board:36476', 'a-public-floor-link'],
        'bahamut',
      ),
    ).toEqual(err(failure));
  });
  it('treats a missing option as "no account named", widening to the channel', async () => {
    const resolved = await resolveUnsubscribeAccounts(platform, undefined);

    expect(resolved.ok && resolved.value).toBeUndefined();
  });

  it('keeps an empty list empty rather than widening it to the whole channel', async () => {
    // The repository matches nothing for an empty list. Collapsing it
    // into `undefined` here would turn "remove nothing" into "remove
    // everything" — the one mistake this command must not make.
    const resolved = await resolveUnsubscribeAccounts(platform, []);

    expect(resolved.ok && resolved.value).toEqual([]);
  });

  it("applies the platform's own normalisation to every entry", async () => {
    const resolved = await resolveUnsubscribeAccounts(platform, ['@SomeOne', 'Another']);

    expect(resolved.ok && resolved.value).toEqual(['someone', 'another']);
  });

  it('keeps the order the member typed, which the confirmation echoes', async () => {
    const resolved = await resolveUnsubscribeAccounts(platform, ['zeta', 'alpha']);

    expect(resolved.ok && resolved.value).toEqual(['zeta', 'alpha']);
  });

  it('fails the whole call on one rejected handle rather than deleting the rest', async () => {
    // A partial deletion would make a typo indistinguishable from an
    // account that had never been subscribed.
    const resolved = await resolveUnsubscribeAccounts(platform, ['someone', 'banned']);

    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.error.messageKey).toBe('errors:feed.invalid_account');
  });

  it('falls back to stripping @ and lower-casing when no platform is named', async () => {
    const resolved = await resolveUnsubscribeAccounts(undefined, ['@SomeOne', '@ANOTHER']);

    expect(resolved.ok && resolved.value).toEqual(['someone', 'another']);
  });

  it('never fails on the fallback path, because no platform rule applies', async () => {
    // A handle the fake platform refuses still resolves here: without a
    // platform there is nothing to validate against, and refusing would
    // block the cleanup of a platform switched off in config.
    const resolved = await resolveUnsubscribeAccounts(undefined, ['banned']);

    expect(resolved.ok && resolved.value).toEqual(['banned']);
  });
});

describe('new feed target removal', () => {
  const channel = 'UCAbCdEfGhIjKlMnOpQrStUv';
  it('preserves case-sensitive YouTube keys and resolves their URLs while disabled', async () => {
    expect(
      await resolveUnsubscribeAccounts(
        undefined,
        [channel, `https://www.youtube.com/channel/${channel}`],
        'youtube',
      ),
    ).toEqual({ ok: true, value: [channel, channel] });
    expect(await resolveUnsubscribeAccounts(undefined, [channel])).toEqual({
      ok: true,
      value: [channel],
    });
  });
  it('requires an available resolver for a disabled YouTube handle', async () => {
    const result = await resolveUnsubscribeAccounts(undefined, ['@somechannel'], 'youtube');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FEED_PLATFORM_NOT_CONFIGURED');
  });
});
