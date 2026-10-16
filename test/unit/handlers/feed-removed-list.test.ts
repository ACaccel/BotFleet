/**
 * How `/feed unsubscribe` reports what it deleted.
 *
 * The bound exists because `deleteMany` has already committed by the
 * time the confirmation is built: a reply over Discord's 2000-character
 * limit would be rejected and the member would be told the operation
 * failed after it had irreversibly succeeded.
 */
import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';

import {
  MAX_LISTED_REMOVALS,
  formatRemovedForLog,
  formatRemovedForReply,
} from '../../../src/handlers/feed-removed-list';
import type { FeedSubscriptionDoc } from '../../../src/persistence/schemas/feed-subscription.schema';

const t = (key: string, params?: Record<string, string | number>): string =>
  params === undefined ? key : `${key}:${JSON.stringify(params)}`;

const subscription = (overrides: Partial<FeedSubscriptionDoc> = {}): FeedSubscriptionDoc => ({
  _id: new Types.ObjectId(),
  platform: 'fake',
  account: 'someone',
  channel_id: 'chan-a',
  created_by: 'u-1',
  created_at: 1_700_000_000_000,
  filter: { media: 'media_only' },
  ...overrides,
});

const many = (count: number): FeedSubscriptionDoc[] =>
  Array.from({ length: count }, (_, index) =>
    subscription({ account: `account-${String(index)}` }),
  );

describe('formatRemovedForReply', () => {
  it('lists one backticked entry per removed subscription', () => {
    const body = formatRemovedForReply(
      [subscription({ account: 'alpha' }), subscription({ platform: 'other', account: 'beta' })],
      t,
    );

    expect(body.split('\n')).toEqual(['`fake @alpha`', '`other @beta`']);
  });

  it('caps the list and names how many were left out', () => {
    const body = formatRemovedForReply(many(MAX_LISTED_REMOVALS + 7), t);
    const lines = body.split('\n');

    expect(lines).toHaveLength(MAX_LISTED_REMOVALS + 1);
    expect(lines.at(-1)).toBe(`replies:feed.unsubscribed_more:{"count":7}`);
  });

  it('adds no tail when everything fits', () => {
    const body = formatRemovedForReply(many(MAX_LISTED_REMOVALS), t);

    expect(body).not.toContain('unsubscribed_more');
    expect(body.split('\n')).toHaveLength(MAX_LISTED_REMOVALS);
  });

  it('stays well inside a single Discord message even at the cap', () => {
    // 2000 is the hard limit; the header and the channel mention share
    // the message, so the list itself must leave room.
    const body = formatRemovedForReply(
      many(MAX_LISTED_REMOVALS + 50).map((doc) => ({ ...doc, account: 'a'.repeat(40) })),
      t,
    );

    expect(body.length).toBeLessThan(1500);
  });
});

describe('formatRemovedForLog', () => {
  it('records the full set, including the destination channel', () => {
    // Unbounded on purpose: this is the durable record of what a member
    // deleted, and the user-facing list is the one that gets truncated.
    const docs = many(MAX_LISTED_REMOVALS + 5);

    const line = formatRemovedForLog(docs);

    expect(line.split('; ')).toHaveLength(docs.length);
    expect(line).toContain('fake @account-0 -> chan-a');
  });
});
