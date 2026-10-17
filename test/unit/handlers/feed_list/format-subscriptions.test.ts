/**
 * `/feed list`'s rendering rules.
 *
 * Three things are easy to get wrong once and never notice: a
 * subscription filed under the wrong channel heading, a subscription
 * whose filter labels never reach its line, and a page that grew past
 * Discord's 2000-character limit and got rejected. Each has a test.
 *
 * Which words a filter gets is `feed-filter-labels.ts`'s decision and is
 * covered by its own suite; what is asserted here is that the line
 * carries them, in place.
 */
import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';

import { formatSubscriptionPages } from '../../../../src/handlers/commands/feed_list/format-subscriptions';
import { FEED_FILTER_SEPARATOR } from '../../../../src/handlers/feed-filter-labels';
import { MAX_PAGE_LENGTH } from '../../../../src/infra/discord/paginate';
import type { FeedSubscriptionDoc } from '../../../../src/persistence/schemas/feed-subscription.schema';

/** Echoes the key, so an assertion names the catalog entry it expects. */
const t = (key: string, params?: Record<string, string | number>): string =>
  params === undefined ? key : `${key}:${JSON.stringify(params)}`;

const subscription = (overrides: Partial<FeedSubscriptionDoc> = {}): FeedSubscriptionDoc =>
  ({
    _id: new Types.ObjectId(),
    platform: 'fake',
    account: 'someone',
    channel_id: 'chan-a',
    created_by: 'u-1',
    created_at: 1_700_000_000_000,
    filter: { media: 'media_only' },
    ...overrides,
  }) as FeedSubscriptionDoc;

describe('formatSubscriptionPages', () => {
  it('identifies forum boards and threads without an account prefix and describes cursor progress', () => {
    const pages = formatSubscriptionPages(
      [
        subscription({
          platform: 'bahamut',
          account: 'board:12345',
          filter: { media: 'any' },
          last_seen_timestamp: 100,
        }),
        subscription({ platform: 'bahamut', account: '12345/42', filter: { media: 'any' } }),
      ],
      t,
    ).join('\n');
    expect(pages).toContain('replies:feed.target_board');
    expect(pages).toContain('replies:feed.target_thread');
    expect(pages).toContain('replies:feed.checked_through');
    expect(pages).toContain('replies:feed.never_checked');
    expect(pages).not.toContain('@board:');
    expect(pages).not.toContain('@12345/42');
  });
  it('returns no pages for an empty list, leaving the copy to the handler', () => {
    expect(formatSubscriptionPages([], t)).toEqual([]);
  });

  it('opens with a header carrying the total count', () => {
    const [page] = formatSubscriptionPages([subscription(), subscription()], t);

    expect(page).toContain('replies:feed.list_header:{"total":2}');
  });

  it('groups by channel under one heading each, keeping first-seen order', () => {
    const pages = formatSubscriptionPages(
      [
        subscription({ account: 'alpha', channel_id: 'chan-a' }),
        subscription({ account: 'beta', channel_id: 'chan-b' }),
        subscription({ account: 'gamma', channel_id: 'chan-a' }),
      ],
      t,
    );

    const lines = (pages[0] ?? '').split('\n');
    expect(lines.filter((line) => line === '<#chan-a>')).toHaveLength(1);
    expect(lines.indexOf('<#chan-b>')).toBeGreaterThan(lines.indexOf('<#chan-a>'));
    // Both chan-a subscriptions sit under the single chan-a heading.
    expect(lines.slice(0, lines.indexOf('<#chan-b>')).join('\n')).toContain('@gamma');
  });

  it('annotates a subscription with its platform and account', () => {
    const [page] = formatSubscriptionPages([subscription()], t);

    expect(page).toContain('`fake @someone`');
  });

  it('carries the shared filter labels onto the line, ahead of the forwarding time', () => {
    const [page] = formatSubscriptionPages(
      [subscription({ filter: { media: 'photo_only', keyword: 'live' }, last_seen_timestamp: 1 })],
      t,
    );

    const line = (page ?? '').split('\n').at(-1) ?? '';
    expect(line).toContain(
      `replies:feed.filter_media.photo_only${FEED_FILTER_SEPARATOR}replies:feed.filter_keyword:{"keyword":"live"}`,
    );
    expect(line.indexOf('replies:feed.filter_media')).toBeLessThan(line.indexOf('<t:1:R>'));
  });

  it('renders the last forwarded time as a Discord relative timestamp', () => {
    const [page] = formatSubscriptionPages(
      [subscription({ last_seen_timestamp: 1_700_000_500 })],
      t,
    );

    expect(page).toContain('<t:1700000500:R>');
    expect(page).not.toContain('replies:feed.never_forwarded');
  });

  it('says so when a subscription has never forwarded anything', () => {
    const [page] = formatSubscriptionPages([subscription()], t);

    expect(page).toContain('replies:feed.never_forwarded');
  });

  it('splits into pages within the message limit without cutting a line', () => {
    const docs = Array.from({ length: 60 }, (_, index) =>
      subscription({ account: `account-${String(index)}`.padEnd(40, 'x') }),
    );

    const pages = formatSubscriptionPages(docs, t);
    const rejoined = pages.join('\n').split('\n');

    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(MAX_PAGE_LENGTH);
    // Every rendered line survives paging intact: one header, one
    // channel heading, and one line per subscription.
    expect(rejoined).toHaveLength(docs.length + 2);
    for (const doc of docs) {
      expect(rejoined.some((line) => line.includes(`\`fake @${doc.account}\``))).toBe(true);
    }
  });

  it('packs each page close to the limit rather than breaking early', () => {
    // Without this, shrinking MAX_PAGE_LENGTH to 200 would still pass
    // every other paging assertion.
    const docs = Array.from({ length: 60 }, (_, index) =>
      subscription({ account: `account-${String(index)}`.padEnd(40, 'x') }),
    );

    const pages = formatSubscriptionPages(docs, t);
    const longestLine = Math.max(
      ...pages.flatMap((page) => page.split('\n').map((line) => line.length)),
    );
    // Every page but the last must be too full to accept one more line.
    for (const page of pages.slice(0, -1)) {
      expect(page.length).toBeGreaterThan(MAX_PAGE_LENGTH - longestLine - 1);
    }
  });

  it('hard-truncates a single line that cannot fit in a message at all', () => {
    // Discord rejects an over-long message outright, which would lose
    // the whole page rather than the tail of one row.
    const [page] = formatSubscriptionPages(
      [subscription({ account: 'a'.repeat(MAX_PAGE_LENGTH + 500) })],
      t,
    );

    expect(page?.length).toBeLessThanOrEqual(MAX_PAGE_LENGTH);
  });
});
