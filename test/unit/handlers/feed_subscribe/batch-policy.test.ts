/**
 * The two rules that end a `/feed subscribe` batch early.
 *
 * `isSystemicFailure` decides whether the remaining accounts are worth
 * attempting, so getting it wrong is expensive in one direction and
 * unhelpful in the other: too eager and a single missing account
 * cancels nineteen good ones, too lax and a rate limit is answered with
 * nineteen more requests.
 */
import { describe, expect, it } from 'vitest';

import {
  FEED_BATCH_BUDGET_MS,
  isSystemicFailure,
} from '../../../../src/handlers/feed-panel/batch-policy';
import { DatabaseError, FeedError } from '../../../../src/core/errors';

const feedError = (code: 'FEED_RATE_LIMITED' | 'FEED_NOT_FOUND' | 'FEED_INVALID_ACCOUNT') =>
  new FeedError({ code, messageKey: 'errors:feed.fetch_failed', context: { operation: 'test' } });

const databaseError = (code: 'DATABASE_TIMEOUT' | 'DATABASE_DUPLICATE_KEY') =>
  new DatabaseError({ code, messageKey: 'errors:db.timeout', context: { operation: 'test' } });

describe('isSystemicFailure', () => {
  it('stops the batch on a rate limit, which the next account would also hit', () => {
    expect(isSystemicFailure(feedError('FEED_RATE_LIMITED'))).toBe(true);
  });

  it.each(['DATABASE_TIMEOUT', 'DATABASE_DUPLICATE_KEY'] as const)(
    'stops the batch on %s, because the database serves every account',
    (code) => {
      expect(isSystemicFailure(databaseError(code))).toBe(true);
    },
  );

  it.each(['FEED_NOT_FOUND', 'FEED_INVALID_ACCOUNT'] as const)(
    'keeps going after %s, which says nothing about the next handle',
    (code) => {
      expect(isSystemicFailure(feedError(code))).toBe(false);
    },
  );

  it.each([new TypeError('bug'), 'not an error', undefined])(
    'keeps going after %s, which carries no taxonomy to judge',
    (cause) => {
      expect(isSystemicFailure(cause)).toBe(false);
    },
  );
});

describe('FEED_BATCH_BUDGET_MS', () => {
  it('leaves the interaction time to deliver the report it produced', () => {
    // Discord expires a deferred interaction 15 minutes after creation.
    // Spending all of it on the batch would write subscriptions the
    // member is never told about.
    expect(FEED_BATCH_BUDGET_MS).toBeLessThan(15 * 60 * 1000);
    expect(FEED_BATCH_BUDGET_MS).toBeGreaterThan(60 * 1000);
  });
});
