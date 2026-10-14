/**
 * `/feed subscribe`'s per-account report, and the operator line beside
 * it.
 *
 * Four things are easy to get wrong and hard to notice: an account
 * that silently drops out of the report — leaving a member believing a
 * handle was subscribed when it was refused — a report that grew past
 * Discord's message limit and was rejected whole after the
 * subscriptions had already been written, a failure rendered as a raw
 * catalog key, and a success line that does not say which filter is now
 * in force, which is how a re-subscribe silently drops a keyword.
 */
import { describe, expect, it } from 'vitest';

import {
  formatOutcomePages,
  formatOutcomesForLog,
} from '../../../../src/handlers/commands/feed_subscribe/format-outcomes';
import type { FeedSubscribeOutcome } from '../../../../src/handlers/commands/feed_subscribe/subscribe-accounts';
import { FEED_FILTER_SEPARATOR } from '../../../../src/handlers/feed-filter-labels';
import { DatabaseError, FeedError } from '../../../../src/core/errors';
import { MAX_PAGE_LENGTH } from '../../../../src/infra/discord/paginate';

/**
 * Echoes the key, so an assertion names the catalog entry it expects.
 * The trailing marker matters: a rendering that equals its own key is
 * how the code detects a catalog miss, so a params-less key must still
 * come back changed here.
 */
const t = (key: string, params?: Record<string, string | number>): string =>
  `${key}:${JSON.stringify(params ?? {})}`;

const context = {
  platform: 'Fake',
  channel: '<#chan-1>',
  filter: { media: 'media_only' },
} as const;

/** The same report, written with a keyword filter. */
const filtered = { ...context, filter: { media: 'video_only', keyword: 'live' } } as const;

const notFound = (account: string): FeedError<{ platform: string; account: string }> =>
  new FeedError({
    code: 'FEED_NOT_FOUND',
    messageKey: 'errors:feed.not_found',
    messageParams: { platform: 'Fake', account },
    context: { operation: 'test' },
  });

const failed = (account: string, cause: unknown = notFound(account)): FeedSubscribeOutcome => ({
  account,
  status: 'failed',
  cause,
});

describe('formatOutcomePages', () => {
  it('returns no pages for an empty batch, which the command never sends', () => {
    expect(formatOutcomePages([], context, t)).toEqual([]);
  });

  it('opens with a header naming the platform and the destination', () => {
    const [page] = formatOutcomePages([{ account: 'alpha', status: 'created' }], context, t);

    expect(page).toContain('replies:feed.subscribe_header');
    expect(page).toContain('"platform":"Fake"');
    expect(page).toContain('"channel":"<#chan-1>"');
  });

  it('gives every account its own line, whatever became of it', () => {
    const [page] = formatOutcomePages(
      [
        { account: 'alpha', status: 'created' },
        { account: 'beta', status: 'updated' },
        failed('ghost'),
        { account: 'delta', status: 'skipped' },
      ],
      context,
      t,
    );

    const lines = (page ?? '').split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain('replies:feed.account_subscribed');
    expect(lines[1]).toContain('"account":"alpha"');
    expect(lines[2]).toContain('replies:feed.account_updated');
    expect(lines[3]).toContain('replies:feed.account_failed');
    expect(lines[4]).toContain('replies:feed.account_skipped');
  });

  it('tells both kinds of success which filter is now in force', () => {
    // Re-subscribing replaces the stored filter wholesale, so an
    // "updated" line that does not name the filter is how a member
    // loses a keyword without being told.
    const [page] = formatOutcomePages(
      [
        { account: 'alpha', status: 'created' },
        { account: 'beta', status: 'updated' },
        failed('ghost'),
        { account: 'delta', status: 'skipped' },
      ],
      filtered,
      t,
    );

    const lines = (page ?? '').split('\n');
    expect(lines[1]).toContain('replies:feed.account_subscribed');
    expect(lines[2]).toContain('replies:feed.account_updated');
    for (const line of [lines[1] ?? '', lines[2] ?? '']) {
      // Both labels, adjacent and in the order `/feed list` prints them.
      // The `:{}` is this suite's echo translator, not the copy.
      expect(line).toContain(
        `replies:feed.filter_media.video_only:{}${FEED_FILTER_SEPARATOR}replies:feed.filter_keyword`,
      );
      expect(line).toContain('live');
    }
    // Nothing was written for these two, so naming a filter on them
    // would describe a subscription that does not exist.
    expect(lines[3]).not.toContain('replies:feed.filter_media');
    expect(lines[4]).not.toContain('replies:feed.filter_media');
  });

  it('names the default filter too, so every success line has the same shape', () => {
    const [page] = formatOutcomePages([{ account: 'alpha', status: 'created' }], context, t);

    expect(page).toContain('replies:feed.filter_media.media_only');
    expect(page).not.toContain('replies:feed.filter_keyword');
  });

  it("renders a failure through the error's own catalog key", () => {
    // Without it the member is told a handle failed but not why, and the
    // per-account reason is the whole point of reporting individually.
    const [page] = formatOutcomePages([failed('ghost')], context, t);

    expect(page).toContain('errors:feed.not_found');
    expect(page).toContain('reason');
  });

  it('renders a database failure through its own copy, not the feed copy', () => {
    const [page] = formatOutcomePages(
      [
        failed(
          'ghost',
          new DatabaseError({
            code: 'DATABASE_TIMEOUT',
            messageKey: 'errors:db.timeout',
            context: { operation: 'test' },
          }),
        ),
      ],
      context,
      t,
    );

    expect(page).toContain('errors:db.timeout');
  });

  it('falls back to the generic reason rather than showing a raw key', () => {
    // i18next echoes an unknown key back unchanged; surfacing that to a
    // member would be worse than admitting the failure in plain words.
    // Only the `errors:` namespace is missing here, so the reply copy
    // around the reason still renders.
    const missingErrorCopy = (key: string, params?: Record<string, string | number>): string =>
      key.startsWith('errors:') ? key : t(key, params);

    const [page] = formatOutcomePages([failed('ghost')], context, missingErrorCopy);

    expect(page).toContain('replies:feed.reason_unknown');
    expect(page).not.toContain('errors:feed.not_found');
  });

  it('falls back to the generic reason for something that is not a domain error', () => {
    const [page] = formatOutcomePages([failed('ghost', new TypeError('bug'))], context, t);

    expect(page).toContain('replies:feed.reason_unknown');
    expect(page).not.toContain('bug');
  });

  it('defuses a quoted-back handle, which is whatever the member typed', () => {
    // The translator interpolates without escaping, so backticks in a
    // rejected handle would rewrite the bot's own message, and an
    // unbounded one would pad the report towards the message limit.
    const [page] = formatOutcomePages(
      [failed('`bad`'), { account: 'x'.repeat(200), status: 'skipped' }],
      context,
      t,
    );

    expect(page).toContain('"account":" bad "');
    expect(page).toContain(`"account":"${'x'.repeat(32)}"`);
    expect(page).not.toContain('x'.repeat(33));
  });

  it('keeps a full batch of long failure lines inside the message limit', () => {
    const outcomes = Array.from({ length: 20 }, (_, index) =>
      failed(`account-name-${String(index)}`.padEnd(180, 'x')),
    );

    const pages = formatOutcomePages(outcomes, context, t);

    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(MAX_PAGE_LENGTH);
    // Nothing is dropped on the way into pages.
    expect(pages.join('\n').split('\n')).toHaveLength(outcomes.length + 1);
  });
});

describe('formatOutcomesForLog', () => {
  it('records each account with its result, and a failure with its code', () => {
    const line = formatOutcomesForLog([
      { account: 'alpha', status: 'created' },
      { account: 'beta', status: 'updated' },
      failed('ghost'),
      { account: 'delta', status: 'skipped' },
    ]);

    expect(line).toBe(
      '@alpha created; @beta updated; @ghost failed(FEED_NOT_FOUND); @delta skipped',
    );
  });

  it('names an unexpected failure rather than leaving the line empty', () => {
    expect(formatOutcomesForLog([failed('ghost', new TypeError('bug'))])).toBe(
      '@ghost failed(UNEXPECTED)',
    );
  });

  it('renders an empty batch as an empty line rather than throwing', () => {
    expect(formatOutcomesForLog([])).toBe('');
  });
});
