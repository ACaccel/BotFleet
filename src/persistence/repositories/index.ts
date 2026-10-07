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
import { MongoArchiveRepo, type ArchiveRepo } from './archive.repo';
import type { GuildConnection } from '../../infra/mongo/connection-manager';

import { MongoActivityRepo, type ActivityRepo } from './activity.repo';
import { MongoFeedSubscriptionRepo, type FeedSubscriptionRepo } from './feed-subscription.repo';
import { MongoFetchRepo, type FetchReader } from './fetch.repo';
import { MongoGiveawayRepo, type GiveawayRepo } from './giveaway.repo';
import { MongoMessageRepo, type MessageReader } from './message.repo';
import { MongoReplyRepo, type ReplyRepo } from './reply.repo';
import { MongoTempRoleRepo, type TempRoleRepo } from './temp-role.repo';
import { MongoThreadModerationRepo, type ThreadModerationRepo } from './thread-moderation.repo';
import { MongoUserApiSettingRepo, type UserApiSettingRepo } from './user-api-setting.repo';
export {
  MongoArchiveRepo,
  type ArchiveRepo,
  type ArchiveMutationInterceptor,
} from './archive.repo';

export { MongoActivityRepo, type ActivityRepo, type ActivityInput } from './activity.repo';
export {
  MongoFeedSubscriptionRepo,
  type FeedSubscriptionRepo,
  type FeedSubscriptionFilterInput,
  type FeedSubscriptionUpsertInput,
  type FeedSubscriptionUpsertResult,
  type FeedSubscriptionDeleteWhere,
} from './feed-subscription.repo';
export { MongoFetchRepo, type FetchReader } from './fetch.repo';
export { MongoGiveawayRepo, type GiveawayRepo, type GiveawayInput } from './giveaway.repo';
export { MongoMessageRepo } from './message.repo';
export { MongoReplyRepo, type ReplyRepo } from './reply.repo';
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
  readonly archive?: ArchiveRepo;
  readonly activity: ActivityRepo;
  readonly fetch: FetchReader;
  readonly giveaway: GiveawayRepo;
  readonly message: MessageReader;
  readonly reply: ReplyRepo;
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
export const buildRepos = (conn: GuildConnection, owner?: 'msg-archive'): Repos => ({
  ...(owner === 'msg-archive' ? { archive: new MongoArchiveRepo(conn, owner) } : {}),
  activity: new MongoActivityRepo(conn),
  fetch: owner === 'msg-archive' ? new MongoFetchRepo(conn) : buildFetchReader(conn),
  giveaway: new MongoGiveawayRepo(conn),
  message: owner === 'msg-archive' ? new MongoMessageRepo(conn) : buildMessageReader(conn),
  reply: new MongoReplyRepo(conn),
  tempRole: new MongoTempRoleRepo(conn),
  threadModeration: new MongoThreadModerationRepo(conn),
  userApiSetting: new MongoUserApiSettingRepo(conn),
  feedSubscription: new MongoFeedSubscriptionRepo(conn),
});

/** Reader objects expose no mutation function to other bot composition roots. */
const buildMessageReader = (conn: GuildConnection): MessageReader => {
  const repo = new MongoMessageRepo(conn);
  return {
    countAll: repo.countAll.bind(repo),
    findRecentByChannel: repo.findRecentByChannel.bind(repo),
    findByMessageId: repo.findByMessageId.bind(repo),
    findByTimestampRange: repo.findByTimestampRange.bind(repo),
    findByChannelAndTimestampRange: repo.findByChannelAndTimestampRange.bind(repo),
    findExistingMessageIds: repo.findExistingMessageIds.bind(repo),
  };
};
const buildFetchReader = (conn: GuildConnection): FetchReader => {
  const repo = new MongoFetchRepo(conn);
  return {
    listChannelIds: repo.listChannelIds.bind(repo),
    findByChannelId: repo.findByChannelId.bind(repo),
  };
};
