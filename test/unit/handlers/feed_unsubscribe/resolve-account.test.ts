/**
 * `/feed unsubscribe`'s account resolution.
 *
 * The deletion scope has to spell every account exactly the way
 * `/feed subscribe` stored it, and the command's `platform` option is
 * optional — so this covers both the platform-informed path and the
 * best-effort fallback that stands in for it, over a list rather than a
 * single handle.
 */
import { describe, expect, it } from 'vitest';

import { resolveUnsubscribeAccounts } from '../../../../src/handlers/commands/feed_unsubscribe/resolve-account';
import { buildFakeFeedPlatform } from '../../../fixtures/social-feed/fake-platform';

const { platform } = buildFakeFeedPlatform({ invalidAccounts: new Set(['banned']) });

describe('resolveUnsubscribeAccounts', () => {
  it('treats a missing option as "no account named", widening to the channel', () => {
    const resolved = resolveUnsubscribeAccounts(platform, undefined);

    expect(resolved.ok && resolved.value).toBeUndefined();
  });

  it('keeps an empty list empty rather than widening it to the whole channel', () => {
    // The repository matches nothing for an empty list. Collapsing it
    // into `undefined` here would turn "remove nothing" into "remove
    // everything" — the one mistake this command must not make.
    const resolved = resolveUnsubscribeAccounts(platform, []);

    expect(resolved.ok && resolved.value).toEqual([]);
  });

  it("applies the platform's own normalisation to every entry", () => {
    const resolved = resolveUnsubscribeAccounts(platform, ['@SomeOne', 'Another']);

    expect(resolved.ok && resolved.value).toEqual(['someone', 'another']);
  });

  it('keeps the order the member typed, which the confirmation echoes', () => {
    const resolved = resolveUnsubscribeAccounts(platform, ['zeta', 'alpha']);

    expect(resolved.ok && resolved.value).toEqual(['zeta', 'alpha']);
  });

  it('fails the whole call on one rejected handle rather than deleting the rest', () => {
    // A partial deletion would make a typo indistinguishable from an
    // account that had never been subscribed.
    const resolved = resolveUnsubscribeAccounts(platform, ['someone', 'banned']);

    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.error.messageKey).toBe('errors:feed.invalid_account');
  });

  it('falls back to stripping @ and lower-casing when no platform is named', () => {
    const resolved = resolveUnsubscribeAccounts(undefined, ['@SomeOne', '@ANOTHER']);

    expect(resolved.ok && resolved.value).toEqual(['someone', 'another']);
  });

  it('never fails on the fallback path, because no platform rule applies', () => {
    // A handle the fake platform refuses still resolves here: without a
    // platform there is nothing to validate against, and refusing would
    // block the cleanup of a platform switched off in config.
    const resolved = resolveUnsubscribeAccounts(undefined, ['banned']);

    expect(resolved.ok && resolved.value).toEqual(['banned']);
  });
});
