import type { ArchiveChannelInfo, StatsWindow } from '../../core/archive/stats';
import type { DatabaseError } from '../../core/errors/external-service-error';
import type { Result } from '../../core/result';

export interface GayStatsQuery {
  readonly userIds: readonly string[];
  readonly channelIds: readonly string[];
  readonly window: StatsWindow;
  readonly timeZone: string;
}

export interface GayArchiveMemberSummary {
  readonly userId: string;
  readonly messages: number;
  readonly activeDays: number;
  /** Fraction of observed content messages containing an emoji; absent if any content is unknown. */
  readonly emojiRatio?: number;
}

interface GayArchivePairSummary {
  /** A and B are the lexicographically sorted requested user IDs. Counts cap each direction at one per local day. */
  readonly repliesABDays?: number;
  readonly repliesBADays?: number;
  /** Mentions accompanying a reply to the same recipient do not count again. */
  readonly mentionsABDays?: number;
  readonly mentionsBADays?: number;
  /** Distinct local dates with both members present in at least one identical channel. */
  readonly sharedChannelDays?: number;
}

export interface GayArchiveSummary {
  readonly members: readonly GayArchiveMemberSummary[];
  /** Absent unless both requested members have archived messages. Unknown source fields stay absent. */
  readonly pair?: GayArchivePairSummary;
}

export interface GayStatsRepo {
  summarize(query: GayStatsQuery): Promise<Result<GayArchiveSummary | undefined, DatabaseError>>;
  listChannels(): Promise<Result<readonly ArchiveChannelInfo[], DatabaseError>>;
}
