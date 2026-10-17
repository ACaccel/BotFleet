/**
 * `/feed subscribe`'s per-account loop.
 *
 * The property under test is isolation: one bad account in a batch must
 * cost that account and nothing else. Every failure mode a single
 * account can hit — an unusable handle, an upstream refusal, a rejected
 * write, an unexpected throw — is exercised with good accounts on both
 * sides of it, because "the batch stopped early" and "the batch skipped
 * one" look identical from a reply that only lists successes.
 *
 * Its two deliberate exceptions get the same treatment from the other
 * direction: a systemic failure and an exhausted time budget must stop
 * the loop and say so, rather than isolating nineteen more times.
 *
 * The fake platform keeps the suite honest about platform neutrality,
 * and its `fetchTimeline` spy is what proves the upstream is read once
 * per new account rather than in parallel or twice.
 */
import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

import { subscribeAccounts } from '../../../../src/handlers/feed-panel/subscribe-accounts';
import { DomainError, FeedError } from '../../../../src/core/errors';
import { err, ok } from '../../../../src/core/result';
import type { FeedSubscriptionRepo } from '../../../../src/persistence/repositories';
import { databaseErrorFrom } from '../../../../src/persistence/error-translator';
import type { FeedSubscriptionDoc } from '../../../../src/persistence/schemas/feed-subscription.schema';
import { buildFakeFeedPlatform, buildFeedPost } from '../../../fixtures/social-feed/fake-platform';

const CHANNEL_ID = 'chan-1';
const USER_ID = 'u-1';

/** Far enough ahead that the budget never expires mid-test. */
const NO_DEADLINE = Number.MAX_SAFE_INTEGER;

const doc = (): FeedSubscriptionDoc => ({
  _id: new Types.ObjectId(),
  platform: 'fake',
  account: 'someone',
  channel_id: CHANNEL_ID,
  created_by: USER_ID,
  created_at: 1_700_000_000_000,
  filter: { media: 'media_only' },
});

const feedError = (code: 'FEED_NOT_FOUND' | 'FEED_RATE_LIMITED'): FeedError<{ platform: string }> =>
  new FeedError({
    code,
    messageKey: `errors:feed.${code === 'FEED_NOT_FOUND' ? 'not_found' : 'rate_limited'}`,
    messageParams: { platform: 'Fake' },
    context: { operation: 'test' },
  });

/** The `DomainError.code` of a caught value, or '' when it is not one. */
const codeOf = (cause: unknown): string => (cause instanceof DomainError ? cause.code : '');

interface Fixture {
  /** Accounts the repository already holds a subscription for. */
  readonly existing?: ReadonlySet<string>;
  /** Accounts whose `upsert` is rejected by the database. */
  readonly upsertFails?: ReadonlySet<string>;
  /** Accounts whose `find` throws instead of resolving. */
  readonly findThrows?: ReadonlySet<string>;
  readonly invalidAccounts?: ReadonlySet<string>;
  /** When set, every upstream read fails with it. */
  readonly failWith?: FeedError<{ platform: string }>;
  readonly deadlineMs?: number;
}

const build = (fixture: Fixture = {}) => {
  const { platform, fetchTimeline } = buildFakeFeedPlatform({
    posts: [buildFeedPost({ id: '42', createdTimestamp: 1_700_000_500 })],
    ...(fixture.failWith === undefined ? {} : { failWith: fixture.failWith }),
    ...(fixture.invalidAccounts === undefined ? {} : { invalidAccounts: fixture.invalidAccounts }),
  });

  const find = vi.fn(async (_platform: string, account: string) => {
    if (fixture.findThrows?.has(account) === true) throw new Error('connection reset');
    return ok(fixture.existing?.has(account) === true ? doc() : undefined);
  });
  const upsert = vi.fn(async (input: { account: string }) =>
    fixture.upsertFails?.has(input.account) === true
      ? err(databaseErrorFrom(new Error('boom'), { operation: 'test' }))
      : ok({ doc: doc(), created: fixture.existing?.has(input.account) !== true }),
  );
  const repo = { find, upsert } as unknown as FeedSubscriptionRepo;
  const logFailure = vi.fn();

  const run = async (accounts: readonly string[]) =>
    subscribeAccounts({
      platform,
      repo,
      accounts,
      channelId: CHANNEL_ID,
      createdBy: USER_ID,
      filter: { media: 'media_only' },
      deadlineMs: fixture.deadlineMs ?? NO_DEADLINE,
      logFailure,
    });

  return { run, find, upsert, fetchTimeline, logFailure };
};

describe('subscribeAccounts', () => {
  it('reports one outcome per account, in the order they were named', async () => {
    const { run } = build({ existing: new Set(['beta']) });

    const outcomes = await run(['alpha', 'beta', 'gamma']);

    expect(outcomes.map((outcome) => [outcome.account, outcome.status])).toEqual([
      ['alpha', 'created'],
      ['beta', 'updated'],
      ['gamma', 'created'],
    ]);
  });

  it('stores the canonical handle, not what the member typed', async () => {
    const { run, find, upsert } = build();

    const outcomes = await run(['@SomeOne']);

    expect(outcomes[0]?.account).toBe('someone');
    // Scoped to the channel: the same account subscribed elsewhere must
    // not make this one look like an existing subscription.
    expect(find).toHaveBeenCalledWith('fake', 'someone', CHANNEL_ID);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ account: 'someone', channel_id: CHANNEL_ID, created_by: USER_ID }),
    );
  });

  it('seeds a cursor for a new subscription and leaves an existing one alone', async () => {
    const { run, upsert } = build({ existing: new Set(['beta']) });

    await run(['alpha', 'beta']);

    expect(upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ last_seen_id: '42', last_seen_timestamp: 1_700_000_500 }),
    );
    const second = (upsert.mock.calls[1]?.[0] ?? {}) as Record<string, unknown>;
    expect('last_seen_id' in second).toBe(false);
    expect('last_seen_timestamp' in second).toBe(false);
  });

  it('reads the upstream once per new account and never for an existing one', async () => {
    const { run, fetchTimeline } = build({ existing: new Set(['beta']) });

    await run(['alpha', 'beta', 'gamma']);

    expect(fetchTimeline).toHaveBeenCalledTimes(2);
    expect(fetchTimeline.mock.calls.map((call) => call[0])).toEqual(['alpha', 'gamma']);
  });

  it('runs the accounts sequentially, not as a burst against the upstream', async () => {
    // A parallel implementation would start every read before the first
    // one resolved, which this counter catches.
    let inFlight = 0;
    let peak = 0;
    const { run, fetchTimeline } = build();
    fetchTimeline.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return ok([]);
    });

    await run(['alpha', 'beta', 'gamma']);

    expect(peak).toBe(1);
  });

  it('applies the invocation filter to every account in the batch', async () => {
    const { run, upsert } = build();

    await run(['alpha', 'beta']);

    for (const [input] of upsert.mock.calls) {
      expect(input).toMatchObject({ filter: { media: 'media_only' } });
    }
  });

  it('keeps going after an unusable handle, and keeps the failure itself', async () => {
    const { run, upsert } = build({ invalidAccounts: new Set(['banned']) });

    const outcomes = await run(['alpha', 'banned', 'gamma']);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['created', 'failed', 'created']);
    expect(outcomes[1]?.account).toBe('banned');
    // The error travels unrendered, so the log can have its code and the
    // reply a sentence in the reader's language.
    expect(codeOf(outcomes[1]?.status === 'failed' ? outcomes[1].cause : undefined)).toBe(
      'FEED_INVALID_ACCOUNT',
    );
    // The good accounts on both sides were still written.
    expect(upsert.mock.calls.map(([input]) => input.account)).toEqual(['alpha', 'gamma']);
  });

  it('keeps going after an upstream refusal that is about one account', async () => {
    const { run } = build({ failWith: feedError('FEED_NOT_FOUND'), existing: new Set(['beta']) });

    const outcomes = await run(['ghost', 'beta']);

    expect(outcomes[0]?.status).toBe('failed');
    // An existing subscription never reads the upstream, so it survives
    // an outage that costs every new account in the same batch.
    expect(outcomes[1]).toMatchObject({ account: 'beta', status: 'updated' });
  });

  it('turns an unexpected throw into that account failing, not the batch', async () => {
    // `isNew` re-throws a repository error, and a bug anywhere in one
    // account's sequence must not take the others down with it.
    const { run } = build({ findThrows: new Set(['beta']) });

    const outcomes = await run(['alpha', 'beta', 'gamma']);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['created', 'failed', 'created']);
    expect(outcomes[1]?.status === 'failed' && outcomes[1].cause).toBeInstanceOf(Error);
  });

  it('hands every absorbed failure to the operator channel', async () => {
    // Isolation hides these from the handler's error boundary, so this
    // callback is the only thing keeping them diagnosable.
    const { run, logFailure } = build({
      invalidAccounts: new Set(['banned']),
      findThrows: new Set(['broken']),
    });

    await run(['banned', 'broken', 'gamma']);

    expect(logFailure).toHaveBeenCalledTimes(2);
    expect(codeOf(logFailure.mock.calls[0]?.[0])).toBe('FEED_INVALID_ACCOUNT');
    expect(logFailure.mock.calls[1]?.[0]).toBeInstanceOf(Error);
  });

  it('stops on a rate limit and reports the rest as not attempted', async () => {
    // Continuing would send more requests at an upstream that just asked
    // to be left alone, and report the same error for every account.
    const { run, fetchTimeline } = build({ failWith: feedError('FEED_RATE_LIMITED') });

    const outcomes = await run(['alpha', 'beta', 'gamma']);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['failed', 'skipped', 'skipped']);
    expect(fetchTimeline).toHaveBeenCalledTimes(1);
  });

  it('stops on a database failure, which the next account would hit too', async () => {
    const { run, upsert } = build({ upsertFails: new Set(['alpha']) });

    const outcomes = await run(['alpha', 'beta']);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['failed', 'skipped']);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('keeps isolating a failure that is only about its own account', async () => {
    // The counterpart of the two above: an unusable handle says nothing
    // about the next one, so the batch must not stop.
    const { run } = build({ invalidAccounts: new Set(['banned']) });

    const outcomes = await run(['banned', 'beta']);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['failed', 'created']);
  });

  it('attempts nothing once the interaction budget has already run out', async () => {
    const { run, fetchTimeline } = build({ deadlineMs: Date.now() - 1 });

    const outcomes = await run(['alpha', 'beta']);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['skipped', 'skipped']);
    expect(fetchTimeline).not.toHaveBeenCalled();
  });

  it('stops mid-batch when the budget runs out, keeping what it wrote', async () => {
    vi.useFakeTimers();
    try {
      const { run, fetchTimeline } = build({ deadlineMs: Date.now() + 60_000 });
      // Each read burns two minutes of the budget.
      fetchTimeline.mockImplementation(async () => {
        vi.advanceTimersByTime(120_000);
        return ok([]);
      });

      const outcomes = await run(['alpha', 'beta', 'gamma']);

      expect(outcomes.map((outcome) => outcome.status)).toEqual(['created', 'skipped', 'skipped']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing at all for an empty batch', async () => {
    const { run, upsert, fetchTimeline } = build();

    expect(await run([])).toEqual([]);
    expect(upsert).not.toHaveBeenCalled();
    expect(fetchTimeline).not.toHaveBeenCalled();
  });
});

describe('subscribeAccounts — snapshot baselines', () => {
  it.each([[[]], [[buildFeedPost({ id: 'opaque-z' }), buildFeedPost({ id: 'opaque-a' })]]])(
    'inserts snapshot IDs and leaves existing subscription progress untouched',
    async (posts) => {
      const fake = buildFakeFeedPlatform({ posts });
      const find = vi.fn(async (_platform: string, account: string) =>
        ok(account === 'existing' ? doc() : undefined),
      );
      const upsert = vi.fn(async () => ok({ doc: doc(), created: true }));
      await subscribeAccounts({
        platform: { ...fake.platform, trackingMode: 'snapshot' },
        repo: { find, upsert } as unknown as FeedSubscriptionRepo,
        accounts: ['new', 'existing'],
        channelId: CHANNEL_ID,
        createdBy: USER_ID,
        filter: { media: 'any', keyword: 'video' },
        deadlineMs: NO_DEADLINE,
        logFailure: vi.fn(),
      });
      expect(upsert).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          seen_ids: posts.map((post) => post.id),
          filter: { media: 'any', keyword: 'video' },
        }),
      );
      expect(upsert).toHaveBeenNthCalledWith(
        2,
        expect.not.objectContaining({ seen_ids: expect.anything() }),
      );
      expect(fake.fetchTimeline).toHaveBeenCalledTimes(1);
    },
  );
});
