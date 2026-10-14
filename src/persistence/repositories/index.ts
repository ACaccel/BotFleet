/**
 * Repository barrel.
 *
 * Re-exports every repo interface + Mongo impl + the aggregate
 * {@link Repos} bag used by composition roots to build a per-guild
 * repository set in one call (`buildRepos(guildConnection)`).
 *
 * Adding a new repo means: write the file, append to the exports
 * below, add a key to `Repos`, and add one line to `buildRepos`.
 */
import type { GuildConnection } from '../connection';

import { MongoActivityRepo, type ActivityRepo } from './activity.repo';
import { MongoAiUsageRepo, type AiUsageRepo } from './ai-usage.repo';
import { MongoArchiveStatsRepo } from './archive-stats.repo';
import type { ArchiveStatsRepo } from './archive-stats.types';
import { MongoFeedSubscriptionRepo, type FeedSubscriptionRepo } from './feed-subscription.repo';
import { MongoGiveawayRepo, type GiveawayRepo } from './giveaway.repo';
import { MongoGayReadingRepo, type GayReadingRepo } from './gay-reading.repo';
import { MongoGayStatsRepo } from './gay-stats.repo';
import type { GayStatsRepo } from './gay-stats.types';
import { MongoReplyRepo, type ReplyRepo } from './reply.repo';
import { MongoRollCallRepo, type RollCallRepo } from './roll-call.repo';
import { MongoTempRoleRepo, type TempRoleRepo } from './temp-role.repo';
import { MongoThreadModerationRepo, type ThreadModerationRepo } from './thread-moderation.repo';
import { MongoUserApiSettingRepo, type UserApiSettingRepo } from './user-api-setting.repo';
export {
  MongoArchiveRepo,
  type ArchiveRepo,
  type ArchiveMutationInterceptor,
} from './archive.repo';

export { MongoActivityRepo, type ActivityRepo, type ActivityInput } from './activity.repo';
export { MongoAiUsageRepo, type AiUsageRepo, type UsageWindow } from './ai-usage.repo';
export { MongoArchiveStatsRepo } from './archive-stats.repo';
export type {
  ArchiveStatsRepo,
  ArchiveStatsScope,
  ActivitySections,
  ActivityReport,
  ComparedActivityReport,
  ActivitySummary,
  ActivityHeatmap,
  AppUsageStats,
  AuthorRanking,
  ChannelRanking,
  EmojiUsage,
  ReactionSummary,
  ReactionsGivenStats,
  ReplyPartnersStats,
  RetentionStats,
  StickerUsage,
  TopReactedMessage,
  TrendBucket,
} from './archive-stats.types';
export {
  MongoFeedSubscriptionRepo,
  type FeedSubscriptionRepo,
  type FeedSubscriptionFilterInput,
  type FeedSubscriptionUpsertInput,
  type FeedSubscriptionUpsertResult,
  type FeedSubscriptionDeleteWhere,
} from './feed-subscription.repo';
export { MongoGiveawayRepo, type GiveawayRepo, type GiveawayInput } from './giveaway.repo';
export { MongoGayReadingRepo, type GayReadingRepo } from './gay-reading.repo';
export { MongoReplyRepo, type ReplyRepo } from './reply.repo';
export { MongoRollCallRepo, type RollCallRepo, type RollCallInput } from './roll-call.repo';
export { MongoTempRoleRepo, type TempRoleRepo, type TempRoleInput } from './temp-role.repo';
export { MongoThreadModerationRepo, type ThreadModerationRepo } from './thread-moderation.repo';
export {
  MongoUserApiSettingRepo,
  type UserApiSettingRepo,
  type UserApiSettingDefaults,
  type UserApiSettingPatch,
} from './user-api-setting.repo';

/**
 * Per-guild repository bag. Composition roots build one of these per
 * guild from the guild's {@link GuildConnection} and stash it where
 * handlers can read it.
 */
export interface Repos {
  readonly activity: ActivityRepo;
  readonly aiUsage: AiUsageRepo;
  /** Read-only archive statistics; every bot may read through its reader connection. */
  readonly archiveStats: ArchiveStatsRepo;
  readonly giveaway: GiveawayRepo;
  readonly gayReading: GayReadingRepo;
  readonly gayStats: GayStatsRepo;
  readonly reply: ReplyRepo;
  readonly rollCall: RollCallRepo;
  readonly tempRole: TempRoleRepo;
  readonly threadModeration: ThreadModerationRepo;
  readonly userApiSetting: UserApiSettingRepo;
  readonly feedSubscription: FeedSubscriptionRepo;
}

/**
 * Build the full {@link Repos} set against one guild's connection.
 * Defined here (not in `core/ioc`) so the IoC layer stays free of
 * persistence imports — composition roots register this builder as
 * the implementation of every `*RepoFactory` token.
 */
export const buildRepos = (conn: GuildConnection): Repos => ({
  activity: new MongoActivityRepo(conn),
  aiUsage: new MongoAiUsageRepo(conn),
  archiveStats: new MongoArchiveStatsRepo(conn),
  giveaway: new MongoGiveawayRepo(conn),
  gayReading: new MongoGayReadingRepo(conn),
  gayStats: new MongoGayStatsRepo(conn),
  reply: new MongoReplyRepo(conn),
  rollCall: new MongoRollCallRepo(conn),
  tempRole: new MongoTempRoleRepo(conn),
  threadModeration: new MongoThreadModerationRepo(conn),
  userApiSetting: new MongoUserApiSettingRepo(conn),
  feedSubscription: new MongoFeedSubscriptionRepo(conn),
});
