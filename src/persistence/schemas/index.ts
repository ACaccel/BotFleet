import {
  archiveInboxSchema,
  archiveJobSchema,
  archiveReactionSchema,
  archiveChannelSchema,
  archiveLeaseSchema,
  type ArchiveReactionDoc,
  type ArchiveLeaseDoc,
} from './archive.schema';
import type { ArchiveInboxDocument, ArchiveJob, ArchiveChannel } from '../../core/archive/types';
/**
 * Schema registry — single source of truth for "which models exist".
 *
 * Each schema lives in its own file so a future change to one schema
 * does not invite drive-by edits to the others.
 */
import { activitySchema, type ActivityDoc } from './activity.schema';
import { aiUsageSchema, type AiUsageDoc } from './ai-usage.schema';
import { bugTicketSchema, type BugTicketDoc } from './bug-ticket.schema';
import { feedSubscriptionSchema, type FeedSubscriptionDoc } from './feed-subscription.schema';
import { fetchSchema, type FetchDoc } from './fetch.schema';
import { giveawaySchema, type GiveawayDoc } from './giveaway.schema';
import { messageSchema, type MessageDoc } from './message.schema';
import { replySchema, type ReplyDoc } from './reply.schema';
import { rollCallSchema, type RollCallDoc } from './roll-call.schema';
import { tempRoleSchema, type TempRoleDoc } from './temp-role.schema';
import {
  threadMessageSourceSchema,
  type ThreadMessageSourceDoc,
} from './thread-message-source.schema';
import { threadModerationSchema, type ThreadModerationDoc } from './thread-moderation.schema';
import { userApiSettingSchema, type UserApiSettingDoc } from './user-api-setting.schema';
export * from './archive.schema';

export { activitySchema, type ActivityDoc } from './activity.schema';
export { aiUsageSchema, type AiUsageDoc } from './ai-usage.schema';
export { bugTicketSchema, type BugTicketDoc } from './bug-ticket.schema';
export {
  feedSubscriptionSchema,
  type FeedSubscriptionDoc,
  type FeedSubscriptionFilter,
  FEED_MEDIA_FILTERS,
  type FeedMediaFilter,
  DEFAULT_FEED_MEDIA_FILTER,
  isFeedMediaFilter,
} from './feed-subscription.schema';
export { fetchSchema, type FetchDoc } from './fetch.schema';
export { giveawaySchema, type GiveawayDoc } from './giveaway.schema';
export { messageSchema, type MessageDoc } from './message.schema';
export { replySchema, type ReplyDoc } from './reply.schema';
export { rollCallSchema, type RollCallDoc } from './roll-call.schema';
export { tempRoleSchema, type TempRoleDoc } from './temp-role.schema';
export {
  threadMessageSourceSchema,
  type ThreadMessageSourceDoc,
} from './thread-message-source.schema';
export { threadModerationSchema, type ThreadModerationDoc } from './thread-moderation.schema';
export { userApiSettingSchema, type UserApiSettingDoc } from './user-api-setting.schema';

export const SCHEMAS = {
  ArchiveInbox: archiveInboxSchema,
  ArchiveJob: archiveJobSchema,
  ArchiveReaction: archiveReactionSchema,
  ArchiveChannel: archiveChannelSchema,
  ArchiveLease: archiveLeaseSchema,
  Fetch: fetchSchema,
  Message: messageSchema,
  Reply: replySchema,
  Giveaway: giveawaySchema,
  Activity: activitySchema,
  TempRole: tempRoleSchema,
  ThreadModeration: threadModerationSchema,
  ThreadMessageSource: threadMessageSourceSchema,
  UserApiSetting: userApiSettingSchema,
  FeedSubscription: feedSubscriptionSchema,
  AiUsage: aiUsageSchema,
  RollCall: rollCallSchema,
  BugTicket: bugTicketSchema,
} as const;

export type SchemaName = keyof typeof SCHEMAS;

/**
 * Mapping from `SchemaName` to inferred doc type. Consumed by
 * `infra/mongo/connection-manager` to derive the typed Models map.
 */
export interface DocByName {
  ArchiveInbox: ArchiveInboxDocument;
  ArchiveJob: ArchiveJob;
  ArchiveReaction: ArchiveReactionDoc;
  ArchiveChannel: ArchiveChannel;
  ArchiveLease: ArchiveLeaseDoc;
  Fetch: FetchDoc;
  Message: MessageDoc;
  Reply: ReplyDoc;
  Giveaway: GiveawayDoc;
  Activity: ActivityDoc;
  TempRole: TempRoleDoc;
  ThreadModeration: ThreadModerationDoc;
  ThreadMessageSource: ThreadMessageSourceDoc;
  UserApiSetting: UserApiSettingDoc;
  FeedSubscription: FeedSubscriptionDoc;
  AiUsage: AiUsageDoc;
  RollCall: RollCallDoc;
  BugTicket: BugTicketDoc;
}
