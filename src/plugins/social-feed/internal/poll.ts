/**
 * One pass of the social-feed poller: read every guild's stored
 * subscriptions, fetch each followed account's recent posts once, and
 * forward what each subscription's own filter accepts.
 *
 * The database is the source of truth for what is followed, so a
 * subscription written by a `/feed_*` command takes effect on the next
 * pass with no cross-module notification.
 *
 * Failure isolation is layered so a background loop can never be taken
 * down by one bad guild, subscription, or send: a guild whose
 * subscription read fails is skipped, an upstream read that fails skips
 * only the subscriptions on that account, each subscription is wrapped
 * individually, and the plugin wrapping this reschedules itself in a
 * `finally`.
 *
 * Cursor discipline — the invariant the whole design rests on:
 *   - the stored cursor is always a post that was *actually delivered*
 *     (or, when a subscription is first seeded, the baseline that
 *     suppresses backfill);
 *   - it advances only after a successful send, so a failed send is
 *     retried on the next pass instead of being skipped;
 *   - it is compared by post id through the platform, never by
 *     timestamp, because an upstream's `since` parameter only gates a
 *     `204` and does not filter the page it returns.
 */
import type { Client, SendableChannels } from 'discord.js';

import type { GuildRegistry } from '../../../bot/guild-registry';
import type { Translator } from '../../../core/i18n';
import { logError, type Logger } from '../../../core/logger';
import type { Clock } from '../../../core/time';
import {
  resolveBaselineCursor,
  type FeedPlatform,
  type FeedPlatformRegistry,
  type FeedPost,
  type FeedPreview,
} from '../../../infra/social-feed';
import type { Repos } from '../../../persistence/repositories';
import type { FeedSubscriptionDoc } from '../../../persistence/schemas/feed-subscription.schema';
import type { SocialFeedPluginConfig } from '../config';
import { selectPostsToForward } from './filter';
import { buildFeedMessage, sendFeedPost } from './post';
import { prepareFeedPreview } from './post';

/** Log binding identifying this plugin in every warn line it emits. */
const PLUGIN = 'social-feed';

/** Collaborators one pass needs. Assembled once in the plugin's `onReady`. */
export interface FeedPassDeps {
  readonly platforms: FeedPlatformRegistry;
  readonly registry: GuildRegistry;
  /** Used to resolve a subscription's destination by channel id. */
  readonly client: Client;
  readonly translator: Translator;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly config: SocialFeedPluginConfig;
}

/** One stored subscription together with where it came from. */
interface SubscriptionRef {
  readonly guildId: string;
  readonly repos: Repos;
  readonly sub: FeedSubscriptionDoc;
}

/**
 * Every subscription in the pass that follows one `(platform, account)`
 * pair, whichever guild or channel it belongs to. One upstream read
 * serves the whole group.
 */
interface AccountGroup {
  readonly platform: FeedPlatform;
  readonly account: string;
  readonly members: readonly SubscriptionRef[];
}

/**
 * A group still being filled. Separate from {@link AccountGroup} so the
 * members list is mutable exactly while it is being built and read-only
 * everywhere it is consumed.
 */
interface AccountGroupBuilder extends Omit<AccountGroup, 'members'> {
  readonly members: SubscriptionRef[];
}

/** One subscription's slice of a pass. */
interface SubscriptionPassInput {
  readonly member: SubscriptionRef;
  readonly platform: FeedPlatform;
  /**
   * Clock reading taken **before** the group's upstream request.
   *
   * Only used when an unseeded subscription meets an empty page, but
   * the ordering matters: a timestamp read after the response could sit
   * past a post published while the request was in flight, and that post
   * would then be skipped forever.
   */
  readonly fetchedAtMs: number;
  /** One preparation per post in this account pass, shared across destinations. */
  readonly previewFor: (post: FeedPost) => Promise<FeedPreview | undefined>;
}

/**
 * Group identity. The account is folded to lower case: platforms treat
 * account names case-insensitively (and normalise them on the way in),
 * so two subscriptions differing only in case follow one account and
 * must not cost two upstream reads.
 */
const groupKey = (platformId: string, account: string): string =>
  `${platformId}:${account.toLowerCase()}`;

/** Key for the once-per-pass "platform not configured" warning. */
const platformWarnKey = (platformId: string, guildId: string): string => `${platformId}@${guildId}`;

/**
 * Read every guild's subscriptions and group them by the account they
 * follow.
 *
 * Grouping spans guilds on purpose. The group is what decides how many
 * times an upstream is read and with which `since` hint, and both
 * answers must account for every subscriber: grouping per guild would
 * read the same account once per guild, and would let one guild's newer
 * cursor pick a `since` that hides posts a second guild has not seen.
 *
 * A guild whose read fails is logged and skipped — the rest of the pass
 * proceeds — and a subscription naming a platform this bot does not
 * have configured is skipped with one warning per guild and platform,
 * not one per subscription. The subscription is never deleted here: an
 * operator re-adding the platform to `social_feed.platforms` must
 * resume the existing subscriptions rather than find them gone.
 */
const collectGroups = async (deps: FeedPassDeps): Promise<readonly AccountGroup[]> => {
  const groups = new Map<string, AccountGroupBuilder>();
  const warnedPlatforms = new Set<string>();

  for (const guildId of deps.registry.listGuildIds()) {
    try {
      const repos = deps.registry.getRepos(guildId);
      // No database for this guild yet — nowhere to read subscriptions
      // from, and nowhere to keep a cursor.
      if (repos === undefined) continue;

      const listed = await repos.feedSubscription.list();
      if (!listed.ok) {
        logError(deps.logger, guildId, listed.error);
        continue;
      }

      for (const sub of listed.value) {
        const platform = deps.platforms.get(sub.platform);
        if (platform === undefined) {
          const warnKey = platformWarnKey(sub.platform, guildId);
          if (!warnedPlatforms.has(warnKey)) {
            warnedPlatforms.add(warnKey);
            deps.logger.warn(
              { plugin: PLUGIN, guildId, platform: sub.platform },
              'social-feed: subscriptions name a platform that is not configured; skipping them',
            );
          }
          continue;
        }
        const key = groupKey(platform.id, sub.account);
        const group = groups.get(key);
        if (group === undefined) {
          groups.set(key, { platform, account: sub.account, members: [{ guildId, repos, sub }] });
        } else {
          group.members.push({ guildId, repos, sub });
        }
      }
    } catch (err: unknown) {
      // Collection runs before any delivery, so an unguarded throw here
      // would cost every guild its pass, not just this one.
      logError(deps.logger, guildId, err);
    }
  }

  return [...groups.values()];
};

/**
 * The `since` hint for one group's upstream read.
 *
 * `since` only decides whether the upstream answers `204`; it does not
 * filter the page it returns. Taking the **minimum** cursor timestamp in
 * the group is therefore what keeps a single shared read correct: a
 * higher `since` could answer "nothing newer" for the whole group while
 * a subscription with an older cursor still had posts to receive. A
 * member that has never been seeded has no timestamp at all, so the
 * hint is dropped entirely — as it is on a full sweep, where the point
 * is to re-read the page a strict `>` comparison would otherwise hide.
 */
const sinceTimestampFor = (group: AccountGroup, fullSweep: boolean): number | undefined => {
  if (fullSweep) return undefined;
  let minimum: number | undefined;
  for (const { sub } of group.members) {
    if (sub.last_seen_timestamp === undefined) return undefined;
    if (minimum === undefined || sub.last_seen_timestamp < minimum) {
      minimum = sub.last_seen_timestamp;
    }
  }
  return minimum;
};

/**
 * Seed a cursor without posting anything.
 *
 * Adding a subscription must not replay the account's existing timeline
 * into the channel, so its first pass only records where the feed
 * starts. The baseline rule itself lives in `infra/social-feed` because
 * the subscribe command seeds a cursor the same way.
 */
const seedCursor = async (
  deps: FeedPassDeps,
  input: SubscriptionPassInput,
  posts: readonly FeedPost[],
): Promise<void> => {
  const { guildId, repos, sub } = input.member;
  const baseline = resolveBaselineCursor(input.platform, posts, input.fetchedAtMs);
  const stored = await repos.feedSubscription.advanceCursor(
    sub._id,
    baseline.lastSeenId,
    baseline.lastSeenTimestamp,
  );
  if (!stored.ok) {
    logError(deps.logger, guildId, stored.error);
    return;
  }
  deps.logger.info(
    {
      plugin: PLUGIN,
      guildId,
      platform: input.platform.id,
      account: sub.account,
      cursor: baseline.lastSeenId,
    },
    'social-feed: baseline cursor seeded; existing posts will not be backfilled',
  );
};

/**
 * Forward `posts` in order, advancing the cursor to the last one that
 * actually reached Discord.
 *
 * The advance happens in a `finally` so a mid-run send failure still
 * records the progress already made; the error then propagates to the
 * per-subscription boundary in {@link runFeedPass}.
 */
const forwardPosts = async (
  deps: FeedPassDeps,
  input: SubscriptionPassInput,
  channel: SendableChannels,
  posts: readonly FeedPost[],
): Promise<void> => {
  const { guildId, repos, sub } = input.member;
  let delivered: FeedPost | undefined;
  try {
    for (const post of posts) {
      const preview = await input.previewFor(post);
      const url =
        preview?.kind === 'rewritten-url'
          ? preview.url
          : preview === undefined
            ? input.platform.toEmbedUrl(post)
            : `<${post.url}>`;
      await sendFeedPost(
        channel,
        buildFeedMessage(deps.translator, input.platform, post, url),
        preview === undefined ? undefined : { result: preview, translator: deps.translator },
      );
      delivered = post;
    }
  } finally {
    if (delivered !== undefined) {
      const stored = await repos.feedSubscription.advanceCursor(
        sub._id,
        delivered.id,
        delivered.createdTimestamp,
      );
      if (!stored.ok) logError(deps.logger, guildId, stored.error);
    }
  }
};

/**
 * Resolve a subscription's destination channel.
 *
 * The lookup goes through the owning guild rather than the client-wide
 * channel cache, which is what keeps one guild's stored channel id from
 * ever addressing another guild's channel (or a DM): each guild has its
 * own database, so a subscription may only ever deliver inside the
 * guild that stored it.
 *
 * Returns `undefined` when the channel is gone from the cache or the
 * bot may no longer post in it. The subscription is deliberately left
 * in place: losing a permission is usually temporary, and silently
 * deleting what a user asked for would be unrecoverable. The warning is
 * emitted only when there was something to deliver, so a channel that
 * is merely quiet does not fill the log.
 */
const resolveChannel = (
  deps: FeedPassDeps,
  member: SubscriptionRef,
  platformId: string,
): SendableChannels | undefined => {
  const guild = deps.client.guilds.cache.get(member.guildId);
  const channel = guild?.channels.cache.get(member.sub.channel_id);
  if (channel === undefined || !channel.isSendable()) {
    deps.logger.warn(
      {
        plugin: PLUGIN,
        guildId: member.guildId,
        channelId: member.sub.channel_id,
        platform: platformId,
        account: member.sub.account,
      },
      'social-feed: subscription channel is missing or not writable; skipping this pass',
    );
    return undefined;
  }
  return channel;
};

/**
 * Apply one group's page to one subscription.
 *
 * Seeding comes before channel resolution because it sends nothing: an
 * unseeded subscription whose channel is currently unusable must still
 * record its baseline, or it would stay unseeded indefinitely — and an
 * unseeded member drops the `since` hint for the whole group, making
 * every other subscriber of that account pay for a full page on every
 * pass.
 */
const pollSubscription = async (
  deps: FeedPassDeps,
  input: SubscriptionPassInput,
  posts: readonly FeedPost[],
): Promise<void> => {
  const { sub } = input.member;
  if (sub.last_seen_id === undefined) {
    await seedCursor(deps, input, posts);
    return;
  }
  const toForward = selectPostsToForward(posts, {
    platform: input.platform,
    account: sub.account,
    filter: sub.filter,
    lastSeenId: sub.last_seen_id,
    maxPosts: deps.config.maxPostsPerPoll,
  });
  if (toForward.length === 0) return;
  const channel = resolveChannel(deps, input.member, input.platform.id);
  if (channel === undefined) return;
  await forwardPosts(deps, input, channel, toForward);
};

/**
 * Run one full pass across every stored subscription.
 *
 * Groups are walked in series rather than fanned out: the point of the
 * poller is to be a quiet background citizen of free upstreams, and a
 * burst of parallel requests is exactly what gets a client rate-limited.
 */
export const runFeedPass = async (deps: FeedPassDeps, fullSweep: boolean): Promise<void> => {
  const groups = await collectGroups(deps);

  for (const group of groups) {
    try {
      const fetchedAtMs = deps.clock.now();
      const fetched = await group.platform.fetchTimeline(group.account, {
        sinceTimestamp: sinceTimestampFor(group, fullSweep),
      });
      if (!fetched.ok) {
        // One read serves every guild subscribing to this account, so
        // the failure belongs to no single guild; the affected ids are
        // bound instead, or an operator could not tell whose feed just
        // went quiet.
        const guildIds = [...new Set(group.members.map((member) => member.guildId))];
        logError(deps.logger.child({ plugin: PLUGIN, guildIds }), null, fetched.error);
        continue;
      }

      const previews = new Map<string, Promise<FeedPreview | undefined>>();
      const previewFor = (post: FeedPost): Promise<FeedPreview | undefined> => {
        let prepared = previews.get(post.id);
        if (prepared === undefined) {
          prepared = prepareFeedPreview(group.platform, post, deps.logger);
          previews.set(post.id, prepared);
        }
        return prepared;
      };
      for (const member of group.members) {
        try {
          await pollSubscription(
            deps,
            { member, platform: group.platform, fetchedAtMs, previewFor },
            fetched.value,
          );
        } catch (err: unknown) {
          // One subscription's failure must not abort the remaining
          // subscriptions in this pass, nor reject the scheduling loop.
          logError(deps.logger, member.guildId, err);
        }
      }
    } catch (err: unknown) {
      // A platform promises to put every failure on the Err rail, but it
      // is an injected seam across an HTTP boundary: one that rejects
      // instead must cost its own group, not every group after it.
      logError(deps.logger, null, err);
    }
  }
};
