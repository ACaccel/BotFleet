/**
 * The suggestions `/feed unsubscribe` offers for its `target` option.
 *
 * The option takes a list, and Discord replaces the whole option value
 * with the chosen suggestion — so the risky part is not which accounts
 * match but what each suggestion's *value* is. A value that dropped the
 * segments already typed would narrow the deletion behind the member's
 * back, which is the one mistake this list could make that they would
 * not notice until the removal came back short.
 */
import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';

import { buildAccountSuggestions } from '../../../../src/handlers/commands/feed_unsubscribe/account-suggestions';
import { MAX_AUTOCOMPLETE_CHOICES } from '../../../../src/infra/discord/autocomplete-limits';
import { FEED_PLATFORM_DISPLAY_NAMES, MAX_FEED_ACCOUNTS } from '../../../../src/infra/social-feed';
import type { FeedSubscriptionDoc } from '../../../../src/persistence/schemas/feed-subscription.schema';

const doc = (account: string, platform = 'x'): FeedSubscriptionDoc => ({
  _id: new Types.ObjectId(),
  platform,
  account,
  channel_id: 'chan-1',
  created_by: 'u-1',
  created_at: 1_700_000_000_000,
  filter: { media: 'media_only' },
});

const values = (docs: readonly FeedSubscriptionDoc[], focused: string, platform?: string) =>
  buildAccountSuggestions(docs, {
    focused,
    ...(platform === undefined ? {} : { platform }),
  }).map((choice) => choice.value);

describe('buildAccountSuggestions', () => {
  it('offers every stored account when nothing has been typed', () => {
    expect(values([doc('alice'), doc('bob')], '')).toEqual(['alice', 'bob']);
  });

  it('matches case-insensitively anywhere in the handle, not just the start', () => {
    const docs = [doc('AliceWonder'), doc('bob'), doc('carolalice')];

    expect(values(docs, 'ALICE')).toEqual(['AliceWonder', 'carolalice']);
  });

  it('ignores a leading @ on the fragment, as the option parser does', () => {
    expect(values([doc('alice'), doc('bob')], '@ali')).toEqual(['alice']);
  });

  it('narrows to one platform when the platform option is filled in', () => {
    const docs = [doc('alice', 'x'), doc('alice', 'bluesky'), doc('bob', 'bluesky')];

    expect(values(docs, '', 'bluesky')).toEqual(['alice', 'bob']);
  });

  it('labels each choice with the platform display name and the handle', () => {
    const [choice] = buildAccountSuggestions([doc('alice')], { focused: '' });

    expect(choice?.name).toBe(`${FEED_PLATFORM_DISPLAY_NAMES.x} @alice`);
  });

  it('lists the same handle once per platform it is subscribed on', () => {
    // Two entries with identical values is the truthful rendering: an
    // `target` given without a `platform` removes the subscription
    // from both, so the labels are what tells them apart.
    const choices = buildAccountSuggestions([doc('alice', 'x'), doc('alice', 'bluesky')], {
      focused: '',
    });

    expect(choices.map((c) => c.name)).toEqual([
      `${FEED_PLATFORM_DISPLAY_NAMES.x} @alice`,
      'bluesky @alice',
    ]);
    expect(choices.map((c) => c.value)).toEqual(['alice', 'alice']);
  });

  it('falls back to the raw platform id for a platform this build does not ship', () => {
    // A subscription can outlive the adapter that created it.
    const [choice] = buildAccountSuggestions([doc('alice', 'bluesky')], { focused: '' });

    expect(choice?.name).toBe('bluesky @alice');
  });

  describe('completing the last segment of a list', () => {
    it('appends the candidate to the segments already typed', () => {
      const docs = [doc('carol'), doc('dave')];

      // Accepting a suggestion must extend the list, not replace it.
      expect(values(docs, 'alice, bob, ca')).toEqual(['alice, bob, carol']);
    });

    it('normalises the earlier segments the way the option parser will', () => {
      const docs = [doc('carol')];

      // `@` stripped, whitespace separators folded to the canonical
      // comma-and-space, so the echoed prefix is what gets deleted.
      expect(values(docs, '@alice   bob , ca')).toEqual(['alice, bob, carol']);
    });

    it('matches only against the last segment, not the whole option', () => {
      const docs = [doc('alice'), doc('bob')];

      // 'alice' is committed; the fragment is 'b'.
      expect(values(docs, 'alice, b')).toEqual(['alice, bob']);
    });

    it('excludes accounts already named in an earlier segment', () => {
      const docs = [doc('alice'), doc('bob')];

      expect(values(docs, 'ALICE, ')).toEqual(['ALICE, bob']);
    });

    it('offers nothing once the list is already over the command own cap', () => {
      const typed = Array.from({ length: MAX_FEED_ACCOUNTS + 1 }, (_, i) => `a${String(i)}`);

      expect(values([doc('bob')], `${typed.join(', ')}, b`)).toEqual([]);
    });

    it('offers nothing once the list has reached the cap exactly', () => {
      // One more entry is one the command would refuse outright, so a
      // suggestion here only helps the member build a rejected list.
      const typed = Array.from({ length: MAX_FEED_ACCOUNTS }, (_, i) => `a${String(i)}`);

      expect(values([doc('bob')], `${typed.join(', ')}, b`)).toEqual([]);
    });
  });

  it('skips a candidate whose value would exceed the 100-character ceiling', () => {
    // Truncating would silently name a different handle, and the member
    // would only find out when nothing was removed.
    const docs = [doc('a'.repeat(60)), doc('short')];

    expect(values(docs, `${'p'.repeat(60)}, `)).toEqual([`${'p'.repeat(60)}, short`]);
  });

  it('skips a candidate whose label would exceed the ceiling', () => {
    const docs = [doc('a'.repeat(120)), doc('short')];

    expect(values(docs, '')).toEqual(['short']);
  });

  it('stops at 25 choices, the most Discord will show', () => {
    const docs = Array.from({ length: 40 }, (_, i) => doc(`account${String(i)}`));

    expect(values(docs, '')).toHaveLength(MAX_AUTOCOMPLETE_CHOICES);
  });

  it('offers nothing when the channel holds no subscriptions', () => {
    expect(values([], 'ali')).toEqual([]);
  });
});

it('keeps YouTube channel IDs that differ only in case distinct when completing a batch', () => {
  const first = 'UCAbCdEfGhIjKlMnOpQrStUv';
  const second = 'UCabCdEfGhIjKlMnOpQrStUv';
  expect(values([doc(first, 'youtube'), doc(second, 'youtube')], `${first}, `, 'youtube')).toEqual([
    `${first}, ${second}`,
  ]);
});
