/**
 * A {@link FeedPlatform} that reads no network.
 *
 * This fixture is the executable evidence that the feed framework is
 * genuinely platform-neutral: the registry, the baseline rule, the
 * poller, and the subscription commands all have to work against a
 * platform the shipped `SUPPORTED_FEED_PLATFORMS` union never names. If
 * any of them can only be driven with X, that shows up here as a test
 * that cannot be written.
 *
 * `fetchTimeline` is a `vi.fn()` so a caller can assert how many
 * upstream reads a pass actually made — the per-pass memo is otherwise
 * invisible from the outside.
 */
import { vi, type Mock } from 'vitest';

import { err, ok, type Result } from '../../../src/core/result';
import { FeedError } from '../../../src/core/errors';
import type { FeedFailure, FeedPlatform, FeedPost } from '../../../src/infra/social-feed';

interface FakeFeedPlatformOptions {
  /** Registry id; defaults to `'fake'`, deliberately outside the shipped union. */
  readonly id?: string;
  readonly displayName?: string;
  /** Page every `fetchTimeline` call resolves with. Defaults to empty. */
  readonly posts?: readonly FeedPost[];
  /** When set, `fetchTimeline` fails with this instead of resolving. */
  readonly failWith?: FeedFailure;
  /** Account strings (post-normalisation) that `normalizeAccount` rejects. */
  readonly invalidAccounts?: ReadonlySet<string>;
}

interface FakeFeedPlatformHandle {
  readonly platform: FeedPlatform;
  /** The same function object as `platform.fetchTimeline`, for assertions. */
  readonly fetchTimeline: Mock;
}

const DEFAULT_ID = 'fake';
const DEFAULT_DISPLAY_NAME = 'Fake';

/**
 * Ids are small decimal strings in these fixtures, so plain numeric
 * ordering is both sufficient and obviously correct at a glance —
 * unlike X's snowflakes, which need `BigInt`.
 *
 * The `NaN` guard is not decoration: {@link FeedPlatform.compareIds}
 * promises `0` for an id it cannot parse, and a fake that returned `NaN`
 * instead would be unable to exercise the degradation path the real
 * platforms take.
 */
const compareIds = (a: string, b: string): number => {
  const difference = Number(a) - Number(b);
  return Number.isNaN(difference) ? 0 : difference;
};

export const buildFakeFeedPlatform = (
  options: FakeFeedPlatformOptions = {},
): FakeFeedPlatformHandle => {
  const displayName = options.displayName ?? DEFAULT_DISPLAY_NAME;
  const invalid = options.invalidAccounts ?? new Set<string>();

  const fetchTimeline = vi.fn(
    async (): Promise<Result<readonly FeedPost[], FeedFailure>> =>
      options.failWith === undefined ? ok(options.posts ?? []) : err(options.failWith),
  );

  const platform: FeedPlatform = {
    id: options.id ?? DEFAULT_ID,
    displayName,
    normalizeAccount: (raw: string): Result<string, FeedFailure> => {
      const account = raw.trim().replace(/^@+/, '').toLowerCase();
      if (account === '' || invalid.has(account)) {
        return err(
          new FeedError({
            code: 'FEED_INVALID_ACCOUNT',
            messageKey: 'errors:feed.invalid_account',
            messageParams: { platform: displayName, account: raw.trim().replace(/^@+/, '') },
            context: { operation: 'FakeFeedPlatform.normalizeAccount' },
          }),
        );
      }
      return ok(account);
    },
    fetchTimeline,
    compareIds,
    baselineIdAt: (nowMs: number): string => String(nowMs),
    toEmbedUrl: (post: FeedPost): string => `https://fake.invalid/${post.id}`,
  };

  return { platform, fetchTimeline };
};

/**
 * A {@link FeedPost} with neutral defaults. Only `id` is required, so a
 * test states the one or two fields its assertion actually turns on.
 */
export const buildFeedPost = (overrides: Partial<FeedPost> & Pick<FeedPost, 'id'>): FeedPost => ({
  authorAccount: 'someaccount',
  createdTimestamp: 1_700_000_000,
  url: `https://fake.invalid/someaccount/status/${overrides.id}`,
  text: '',
  isReply: false,
  isRepost: false,
  media: [],
  ...overrides,
});
