/**
 * Result and query types of the archive statistics reader. Split from the
 * repository so the report assembly and the Mongo driver share them without an
 * import cycle.
 */
import type { ArchiveChannelInfo, StatsGranularity, StatsWindow } from '../../core/archive/stats';
import type { DatabaseError } from '../../core/errors/external-service-error';
import type { Result } from '../../core/result';

/** Channels the invoker may see; an empty list counts nothing. */
export interface ArchiveStatsScope {
  readonly channelIds: readonly string[];
}
/** Messages per content category; one message can count in several. */
interface ContentBreakdown {
  /** Has an `image/*` or `video/*` attachment. */
  readonly media: number;
  /** Has another attachment and is not a voice message. */
  readonly files: number;
  readonly voice: number;
  /** Text contains an `http://` or `https://` URL. */
  readonly links: number;
  readonly stickers: number;
  readonly polls: number;
  readonly forwards: number;
  readonly replies: number;
}
export interface ActivitySummary {
  readonly messages: number;
  readonly activeMembers: number;
  /** Distinct channels after attribution: text-channel threads fold into their channel. */
  readonly activeChannels: number;
  /** Messages edited at least once. */
  readonly edited: number;
  readonly content: ContentBreakdown;
  /** The same count over `previousWindow`; present when the query has one. */
  readonly previousMessages?: number;
}
/**
 * One trend bucket. `key` is local to the requested time zone: `YYYY-MM-DDTHH`
 * (hour), `YYYY-MM-DD` (day) or the `YYYY-MM-DD` of the week's Monday (week).
 */
export interface TrendBucket {
  readonly key: string;
  readonly messages: number;
}
interface ActivityTrend {
  readonly granularity: StatsGranularity;
  /** Every bucket the window touches, oldest first, zero-filled. */
  readonly current: readonly TrendBucket[];
  /** Same layout over `previousWindow`; present when the query has one. */
  readonly previous?: readonly TrendBucket[];
}
export interface ActivityHeatmap {
  /** `cells[weekday][hour]`, weekday 0 = Monday … 6 = Sunday, local hours 0–23. */
  readonly cells: readonly (readonly number[])[];
}
export interface ChannelActivity {
  /** The channel, a text channel with its threads folded in, or a forum post. */
  readonly channelId: string;
  readonly messages: number;
  /** Last name recorded in `archive_channels`; prefer the live name when available. */
  readonly name?: string;
  readonly type?: number;
  /** `archive_channels` records the channel as deleted. */
  readonly deleted: boolean;
  /** The forum or media channel of a post row. */
  readonly forum?: { readonly channelId: string; readonly name?: string };
}
export interface ChannelRanking {
  /** Highest message count first, at most `limit` rows. */
  readonly rows: readonly ChannelActivity[];
  /** Rows before the limit. */
  readonly distinct: number;
  readonly total: number;
}
interface AuthorActivity {
  readonly userId: string;
  readonly messages: number;
  /** Newest names observed in the window; prefer the live member name when available. */
  readonly username?: string;
  readonly globalName?: string;
}
export interface AuthorRanking {
  readonly rows: readonly AuthorActivity[];
  readonly distinct: number;
  readonly total: number;
  /** Present when `rankOf` was requested; `rank` is `null` without messages. Ties share a rank. */
  readonly subject?: {
    readonly userId: string;
    readonly rank: number | null;
    readonly messages: number;
  };
}
/** A reaction identified by its custom emoji ID or Unicode emoji (`key`). */
export interface ReactionCount {
  readonly key: string;
  readonly emojiId?: string;
  readonly name?: string;
  readonly animated?: boolean;
  readonly count: number;
}
export interface ReactionSummary {
  /** Sum of the last observed reaction counts, super reactions included. */
  readonly total: number;
  readonly top: readonly ReactionCount[];
}
export interface RetentionStats {
  readonly previousMembers: number;
  readonly currentMembers: number;
  /** Active in both windows. */
  readonly retained: number;
  /** Active now but not in the previous window: new and returning members. */
  readonly returningOrNew: number;
  /** `retained / previousMembers`, or `null` when the previous window had nobody. */
  readonly retentionRate: number | null;
}
interface ActiveDaysStats {
  readonly activeDays: number;
  readonly longestStreak: number;
  /** Local `YYYY-MM-DD` days with a message, oldest first. */
  readonly dayKeys: readonly string[];
}
export interface ReplyPartner {
  readonly userId: string;
  /** The member replied to this partner. */
  readonly repliesTo: number;
  /** This partner replied to the member. */
  readonly repliesFrom: number;
  readonly mentionsTo: number;
  readonly mentionsFrom: number;
  readonly total: number;
}
export interface ReplyPartnersStats {
  /** Highest total first, at most `limit` partners. */
  readonly partners: readonly ReplyPartner[];
  /** Sums over every partner, before the limit. */
  readonly totals: {
    readonly repliesSent: number;
    readonly repliesReceived: number;
    readonly mentionsSent: number;
    /** Mentions by others, not counting the automatic mention of a reply. */
    readonly mentionsReceived: number;
  };
}
export interface TopReactedMessage {
  readonly messageId: string;
  readonly channelId: string;
  readonly createdTimestamp: number;
  readonly author: {
    readonly id: string;
    readonly username?: string;
    readonly globalName?: string;
  };
  /** Current text; formatting it for display is the command's job. */
  readonly content?: string;
  readonly flags?: number;
  readonly edited: boolean;
  readonly attachments: readonly { readonly contentType?: string; readonly name?: string }[];
  readonly stickers: readonly { readonly id?: string; readonly name?: string }[];
  readonly pollQuestion?: string;
  /** Text of a forwarded message. */
  readonly forwardedContent?: string;
  readonly totalReactions: number;
  /**
   * Distinct users who reacted, from the stored member lists; at least the largest
   * single reaction count when those lists are missing or partial.
   */
  readonly reactors: number;
  /** Highest count first. */
  readonly reactions: readonly ReactionCount[];
}
export interface ReactionsGivenStats {
  /** Reactions the member added to other members' messages (a lower bound: only fetched lists). */
  readonly total: number;
  readonly byEmoji: readonly ReactionCount[];
}
interface AppUsageRow {
  /** The application ID, or the bot user ID when the record has none. */
  readonly applicationId: string;
  readonly username?: string;
  readonly globalName?: string;
  /** Distinct interactions (a reply and its follow-ups count once). */
  readonly uses: number;
  readonly commands: number;
  /** Buttons and select menus. */
  readonly components: number;
  readonly modals: number;
  readonly users: number;
}
export interface AppUsageStats {
  readonly uses: number;
  /** Distinct members who triggered an interaction; bot users never count. */
  readonly users: number;
  /** Earliest interaction in the window. */
  readonly firstRecordAt?: number;
  /** Most used first. */
  readonly apps: readonly AppUsageRow[];
  /** Members (never bots) with the most uses, at most `limit`. */
  readonly topUsers: readonly { readonly userId: string; readonly uses: number }[];
  readonly trend?: readonly { readonly key: string; readonly uses: number }[];
  /** Present when requested. */
  readonly heatmap?: ActivityHeatmap;
}
export interface EmojiUsage {
  readonly emojiId: string;
  /** Occurrences in message text. */
  readonly messageUses: number;
  /** Last observed reaction counts. */
  readonly reactionUses: number;
}
export interface StickerUsage {
  readonly stickerId: string;
  readonly uses: number;
}

/** Statistics {@link ArchiveStatsRepo.activity} can compute in one scan. */
export interface ActivitySections {
  readonly summary?: { readonly authorId?: string };
  readonly trend?: { readonly granularity: StatsGranularity; readonly authorId?: string };
  readonly heatmap?: { readonly authorId?: string };
  /** `fold` (default `true`) applies the channel attribution rule; `false` keeps one row per channel or thread. */
  readonly channels?: {
    readonly authorId?: string;
    readonly fold?: boolean;
    readonly limit?: number;
  };
  readonly authors?: { readonly limit?: number; readonly rankOf?: string };
  readonly reactions?: { readonly authorId?: string; readonly limit?: number };
  /** Requires `previousWindow`. */
  readonly retention?: Record<string, never>;
  readonly activeDays?: { readonly userId: string };
  /**
   * `excludeUserIds`: bots the caller knows of. A member the subject replied to whose
   * message was a bot's is excluded too; a bot only ever mentioned is not knowable.
   */
  readonly partners?: {
    readonly userId: string;
    readonly limit?: number;
    readonly excludeUserIds?: readonly string[];
  };
  readonly topMessages?: { readonly limit: number };
}
/** Sections that need no previous window. */
export type CurrentSections = Omit<ActivitySections, 'retention'>;

export interface ActivityResults {
  summary: ActivitySummary;
  trend: ActivityTrend;
  heatmap: ActivityHeatmap;
  channels: ChannelRanking;
  authors: AuthorRanking;
  reactions: ReactionSummary;
  retention: RetentionStats;
  activeDays: ActiveDaysStats;
  partners: ReplyPartnersStats;
  topMessages: readonly TopReactedMessage[];
}
/** With a previous window, the previous count and trend are always present. */
interface ComparedResults extends Omit<ActivityResults, 'summary' | 'trend'> {
  summary: ActivitySummary & { readonly previousMessages: number };
  trend: ActivityTrend & { readonly previous: readonly TrendBucket[] };
}

type ReportOf<S, R> = {
  readonly [K in keyof S & keyof R]-?: undefined extends S[K] ? R[K] | undefined : R[K];
};
export type ActivityReport<S extends ActivitySections> = ReportOf<S, ActivityResults>;
export type ComparedActivityReport<S extends ActivitySections> = ReportOf<S, ComparedResults>;

/**
 * Rejects at compile time a section name the reader does not know and an empty
 * section set; `planActivity` repeats the empty check at run time.
 */
type KnownSections<S> = Record<Exclude<keyof S, keyof ActivitySections>, never> &
  ([keyof S] extends [never] ? { readonly 'request at least one section': never } : unknown);

interface ActivityQueryBase<S> {
  readonly window: StatsWindow;
  readonly scope: ArchiveStatsScope;
  /** IANA zone for trend, heat map and active days (the bot host's zone). */
  readonly timeZone: string;
  readonly sections: S & KnownSections<S>;
}
/** Compared with `previousWindow`: previous counts, previous trend and retention. */
export interface ComparedActivityQuery<S extends ActivitySections> extends ActivityQueryBase<S> {
  readonly previousWindow: StatsWindow;
}
export interface CurrentActivityQuery<S extends CurrentSections> extends ActivityQueryBase<S> {
  readonly previousWindow?: undefined;
}
/** Either query shape, as the implementation sees it. */
export interface AnyActivityQuery {
  readonly window: StatsWindow;
  readonly previousWindow?: StatsWindow;
  readonly scope: ArchiveStatsScope;
  readonly timeZone: string;
  readonly sections: ActivitySections;
}

export interface AppUsageOptions {
  readonly applicationId?: string;
  readonly userId?: string;
  readonly limit?: number;
  readonly trend?: { readonly granularity: StatsGranularity; readonly timeZone: string };
  /** Weekday x hour interactions in this zone. */
  readonly heatmap?: { readonly timeZone: string };
}

export interface ArchiveStatsRepo {
  /** Several statistics in one indexed scan; see {@link ActivitySections}. */
  activity<S extends ActivitySections>(
    query: ComparedActivityQuery<S>,
  ): Promise<Result<ComparedActivityReport<S>, DatabaseError>>;
  activity<S extends CurrentSections>(
    query: CurrentActivityQuery<S>,
  ): Promise<Result<ActivityReport<S>, DatabaseError>>;
  /** From `archive_reactions`, on member messages created in the window. */
  reactionsGiven(
    window: StatsWindow,
    userId: string,
    scope: ArchiveStatsScope,
  ): Promise<Result<ReactionsGivenStats, DatabaseError>>;
  /** Interaction records only; `userId` narrows to interactions that member triggered. */
  appUsage(
    window: StatsWindow,
    scope: ArchiveStatsScope,
    options?: AppUsageOptions,
  ): Promise<Result<AppUsageStats, DatabaseError>>;
  /** Every given emoji in input order, zero counts included; all channels. */
  emojiUsage(
    window: StatsWindow,
    emojiIds: readonly string[],
  ): Promise<Result<readonly EmojiUsage[], DatabaseError>>;
  /** Every given sticker in input order, zero counts included; all channels. */
  stickerUsage(
    window: StatsWindow,
    stickerIds: readonly string[],
  ): Promise<Result<readonly StickerUsage[], DatabaseError>>;
  /** Every `archive_channels` record, deleted channels included. */
  listChannels(): Promise<Result<readonly ArchiveChannelInfo[], DatabaseError>>;
  /** Whether a full backup of this guild has ever completed (`archive_jobs`, read-only). */
  fullBackupCompleted(): Promise<Result<boolean, DatabaseError>>;
}
