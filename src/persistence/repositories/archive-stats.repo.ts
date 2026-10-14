/**
 * `ArchiveStatsRepo` — read-only `/traffic` statistics. Every method is a MongoDB
 * aggregation that counts in the database and returns plain results, never
 * message documents.
 *
 * Every bot reaches it through its reader connection because it only reads
 * `messages`, `archive_channels`, `archive_reactions` and `archive_jobs` (to tell
 * whether a full backup has completed); writes stay with msg-archive.
 *
 * Counting rules (shared with `core/archive/stats`): time is `createdTimestamp`;
 * deleted messages count; documents without `author` never count; bot and webhook
 * messages count only as interaction records in {@link ArchiveStatsRepo.appUsage};
 * only default (0) and reply (19) messages count. Member statistics are limited to
 * the caller's visible `channelIds`; emoji and sticker usage deliberately cover
 * every channel and show no channel information.
 *
 * Errors: every query runs with `maxTimeMS` (60 seconds by default); exceeding it
 * returns `DATABASE_QUERY_TIMEOUT`, which the commands answer with "range too
 * large". Invalid arguments are programmer errors and throw.
 */
import {
  assertTimeZone,
  type ArchiveChannelInfo,
  type StatsWindow,
} from '../../core/archive/stats';
import type { DatabaseError } from '../../core/errors/external-service-error';
import { err, ok, type Result } from '../../core/result';
import type { GuildConnection } from '../connection';
import { databaseErrorFrom } from '../error-translator';
import {
  activityPipeline,
  appUsagePipeline,
  emojiUsagePipeline,
  facetName,
  reactionsGivenPipeline,
  scanIndexHint,
  stickerUsagePipeline,
  type Stage,
} from './archive-stats.pipelines';
import {
  assertWindow,
  buildAppUsage,
  buildReport,
  num,
  planActivity,
  reactionCount,
  record,
  resolveLimit,
  rows,
  type FacetOutput,
  type Row,
} from './archive-stats.report';
import type {
  ActivityReport,
  ActivitySections,
  AnyActivityQuery,
  AppUsageOptions,
  AppUsageStats,
  ArchiveStatsRepo,
  ArchiveStatsScope,
  ComparedActivityQuery,
  ComparedActivityReport,
  CurrentActivityQuery,
  CurrentSections,
  EmojiUsage,
  ReactionsGivenStats,
  StickerUsage,
} from './archive-stats.types';

/** Scans without a channel scope read by time. */
const TIME_INDEX = { createdTimestamp: 1 } as const;
/** Default query time limit; past it the command asks for a smaller range. */
const ARCHIVE_STATS_MAX_TIME_MS = 60_000;

const CHANNEL_PROJECTION = {
  _id: 0,
  channelId: 1,
  name: 1,
  type: 1,
  parentId: 1,
  access: 1,
  everyoneCanView: 1,
} as const;

/** Mongo-backed implementation over one guild's reader connection. */
export class MongoArchiveStatsRepo implements ArchiveStatsRepo {
  private readonly maxTimeMs: number;

  public constructor(
    private readonly conn: GuildConnection,
    options: { readonly maxTimeMs?: number } = {},
  ) {
    this.maxTimeMs = options.maxTimeMs ?? ARCHIVE_STATS_MAX_TIME_MS;
  }

  public activity<S extends ActivitySections>(
    query: ComparedActivityQuery<S>,
  ): Promise<Result<ComparedActivityReport<S>, DatabaseError>>;
  public activity<S extends CurrentSections>(
    query: CurrentActivityQuery<S>,
  ): Promise<Result<ActivityReport<S>, DatabaseError>>;
  // The overloads tie each requested section to its result; `buildReport` fills
  // exactly the requested sections, which its return type cannot follow.
  public async activity(query: AnyActivityQuery): Promise<Result<never, DatabaseError>> {
    const operation = 'MongoArchiveStatsRepo.activity';
    const plan = planActivity(query, operation);
    const pipeline = activityPipeline(query.scope.channelIds, plan);
    let output: FacetOutput;
    let lookup: ReadonlyMap<string, ArchiveChannelInfo>;
    try {
      [output = {}] = await this.aggregate<FacetOutput>(
        'messages',
        pipeline,
        await this.scanHint(query.scope.channelIds),
      );
      const channelIds = new Set<string>();
      for (const { filter } of plan.channels)
        for (const row of output[facetName('channels', filter, plan.filters)] ?? [])
          channelIds.add(String(row._id));
      lookup = channelIds.size === 0 ? new Map() : await this.channelLookup([...channelIds]);
    } catch (rawErr: unknown) {
      return err(databaseErrorFrom(rawErr, { operation }));
    }
    return ok(buildReport(query, plan, output, lookup) as never);
  }

  public async reactionsGiven(
    window: StatsWindow,
    userId: string,
    scope: ArchiveStatsScope,
  ): Promise<Result<ReactionsGivenStats, DatabaseError>> {
    const operation = 'MongoArchiveStatsRepo.reactionsGiven';
    assertWindow(window, operation);
    let output: Row[];
    try {
      output = await this.aggregate<Row>(
        'archive_reactions',
        reactionsGivenPipeline(window, userId, scope.channelIds),
      );
    } catch (rawErr: unknown) {
      return err(databaseErrorFrom(rawErr, { operation }));
    }
    const byEmoji = output.map((row) =>
      reactionCount(String(row._id), record(row.emoji), num(row.count)),
    );
    return ok({ total: byEmoji.reduce((sum, row) => sum + row.count, 0), byEmoji });
  }

  public async appUsage(
    window: StatsWindow,
    scope: ArchiveStatsScope,
    options: AppUsageOptions = {},
  ): Promise<Result<AppUsageStats, DatabaseError>> {
    const operation = 'MongoArchiveStatsRepo.appUsage';
    assertWindow(window, operation);
    const limit = resolveLimit(options.limit, operation);
    if (options.trend !== undefined) assertTimeZone(options.trend.timeZone);
    if (options.heatmap !== undefined) assertTimeZone(options.heatmap.timeZone);
    const pipeline = appUsagePipeline(window, scope.channelIds, {
      ...(options.applicationId === undefined ? {} : { applicationId: options.applicationId }),
      ...(options.userId === undefined ? {} : { userId: options.userId }),
      limit,
      time: options.trend !== undefined || options.heatmap !== undefined,
    });
    let output: FacetOutput;
    try {
      const hint = await this.scanHint(scope.channelIds);
      [output = {}] = await this.aggregate<FacetOutput>('messages', pipeline, hint);
    } catch (rawErr: unknown) {
      return err(databaseErrorFrom(rawErr, { operation }));
    }
    return ok(buildAppUsage(output, window, options));
  }

  public async emojiUsage(
    window: StatsWindow,
    emojiIds: readonly string[],
  ): Promise<Result<readonly EmojiUsage[], DatabaseError>> {
    const operation = 'MongoArchiveStatsRepo.emojiUsage';
    assertWindow(window, operation);
    if (emojiIds.length === 0) return ok([]);
    let output: FacetOutput;
    try {
      [output = {}] = await this.aggregate<FacetOutput>(
        'messages',
        emojiUsagePipeline(window, emojiIds),
        TIME_INDEX,
      );
    } catch (rawErr: unknown) {
      return err(databaseErrorFrom(rawErr, { operation }));
    }
    const content = new Map(rows(output.content).map((row) => [String(row._id), num(row.count)]));
    const reactions = new Map(
      rows(output.reactions).map((row) => [String(row._id), num(row.count)]),
    );
    return ok(
      emojiIds.map((emojiId) => ({
        emojiId,
        messageUses: content.get(emojiId) ?? 0,
        reactionUses: reactions.get(emojiId) ?? 0,
      })),
    );
  }

  public async stickerUsage(
    window: StatsWindow,
    stickerIds: readonly string[],
  ): Promise<Result<readonly StickerUsage[], DatabaseError>> {
    const operation = 'MongoArchiveStatsRepo.stickerUsage';
    assertWindow(window, operation);
    if (stickerIds.length === 0) return ok([]);
    let output: Row[];
    try {
      output = await this.aggregate<Row>(
        'messages',
        stickerUsagePipeline(window, stickerIds),
        TIME_INDEX,
      );
    } catch (rawErr: unknown) {
      return err(databaseErrorFrom(rawErr, { operation }));
    }
    const counts = new Map(output.map((row) => [String(row._id), num(row.count)]));
    return ok(stickerIds.map((stickerId) => ({ stickerId, uses: counts.get(stickerId) ?? 0 })));
  }

  public async listChannels(): Promise<Result<readonly ArchiveChannelInfo[], DatabaseError>> {
    try {
      return ok(await this.findChannels({}));
    } catch (rawErr: unknown) {
      return err(databaseErrorFrom(rawErr, { operation: 'MongoArchiveStatsRepo.listChannels' }));
    }
  }

  public async fullBackupCompleted(): Promise<Result<boolean, DatabaseError>> {
    try {
      const job = await this.conn.models.ArchiveJob.collection.findOne(
        { command: 'full-backup', status: 'complete' },
        { projection: { _id: 1 }, maxTimeMS: this.maxTimeMs },
      );
      return ok(job !== null);
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, { operation: 'MongoArchiveStatsRepo.fullBackupCompleted' }),
      );
    }
  }

  /**
   * Runs a pipeline under the time limit. Rows are not validated: the report
   * builders read every field through tolerant accessors (`num`, `text`, `record`).
   */
  private async aggregate<T extends Row>(
    collection: 'messages' | 'archive_reactions',
    pipeline: Stage[],
    hint?: Readonly<Record<string, 1>>,
  ): Promise<T[]> {
    const model =
      collection === 'messages' ? this.conn.models.Message : this.conn.models.ArchiveReaction;
    return model.collection
      .aggregate<T>(pipeline, {
        maxTimeMS: this.maxTimeMs,
        allowDiskUse: true,
        ...(hint === undefined ? {} : { hint: { ...hint } }),
      })
      .toArray();
  }

  /** The `messages` index a scan over these channels uses; see `scanIndexHint`. */
  private async scanHint(channelIds: readonly string[]): Promise<Readonly<Record<string, 1>>> {
    const recorded = await this.conn.models.ArchiveChannel.collection.estimatedDocumentCount({
      maxTimeMS: this.maxTimeMs,
    });
    return scanIndexHint(channelIds.length, recorded);
  }

  private async findChannels(filter: Row): Promise<ArchiveChannelInfo[]> {
    return this.conn.models.ArchiveChannel.collection
      .find<ArchiveChannelInfo>(filter, {
        projection: CHANNEL_PROJECTION,
        maxTimeMS: this.maxTimeMs,
      })
      .toArray();
  }

  /** Records of the given channels and of their parents, for attribution and names. */
  private async channelLookup(
    channelIds: readonly string[],
  ): Promise<ReadonlyMap<string, ArchiveChannelInfo>> {
    const lookup = new Map<string, ArchiveChannelInfo>();
    const load = async (ids: readonly string[]): Promise<void> => {
      if (ids.length === 0) return;
      for (const info of await this.findChannels({ channelId: { $in: [...ids] } }))
        lookup.set(info.channelId, info);
    };
    await load(channelIds);
    const parents = new Set<string>();
    for (const info of lookup.values())
      if (info.parentId !== undefined && !lookup.has(info.parentId)) parents.add(info.parentId);
    await load([...parents]);
    return lookup;
  }
}
