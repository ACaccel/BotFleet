import type { GuildBasedChannel } from 'discord.js';
import type { ArchiveChannel, ArchiveHistoryCheckpoint } from '../../../core/archive/types';
import { snowflakeTimestamp } from '../../../core/archive/normalize';
import type { Logger } from '../../../core/logger';
import { databaseErrorFrom, isTransient } from '../../../persistence/error-translator';
import type {
  ArchiveRepo,
  StoredSourceWork,
  StoredSourceWorkQuery,
} from '../../../persistence/repositories/archive.repo';
import {
  isSnowflake,
  orderSourcesByWork,
  type SourceResume,
  type SourceWorkBasis,
  type SourceWorkHint,
  type StoredWork,
} from '../flow/source-work';

/**
 * Stored estimates, most informative first. The first sums reaction lists and reads
 * every document; the second counts messages from the index alone. A query that
 * fails or exceeds its time falls back to the next, and finally to discovery hints
 * alone; a lost connection or an abort skips straight to discovery hints.
 */
const STORED_ESTIMATES = [
  { source: 'reactions', reactions: true, maxTimeMs: 20_000 },
  { source: 'messages', reactions: false, maxTimeMs: 10_000 },
] as const satisfies readonly (Pick<StoredSourceWorkQuery, 'reactions' | 'maxTimeMs'> & {
  readonly source: string;
})[];
type StoredEstimateSource = (typeof STORED_ESTIMATES)[number]['source'] | 'none';
/**
 * Resumed sources are recounted below their cursors by an index-bounded query.
 * Beyond this many, or when that query fails, they keep their whole stored count,
 * which only overstates their remaining work.
 */
const RESUMED_SOURCE_LIMIT = 500;
const RESUMED_MAX_TIME_MS = 5_000;

const fullBackupCheckpoint = (
  record: ArchiveChannel | undefined,
  runId: string,
): ArchiveHistoryCheckpoint | undefined => {
  const checkpoint = record?.checkpoints?.['full-backup'];
  return checkpoint?.runId === runId ? checkpoint : undefined;
};

/** A source this run started and has not finished: its backward cursor and progress. */
const resumeOf = (record: ArchiveChannel | undefined, runId: string): SourceResume | undefined => {
  const checkpoint = fullBackupCheckpoint(record, runId);
  return checkpoint === undefined ||
    checkpoint.complete ||
    !isSnowflake(checkpoint.before) ||
    (checkpoint.pageSequence ?? 0) === 0
    ? undefined
    : { before: checkpoint.before, scanned: checkpoint.scanned ?? 0 };
};

/** A completed scan without a lower bound read the source's whole history. */
const completeFullScan = (checkpoint: ArchiveHistoryCheckpoint | undefined): boolean =>
  checkpoint?.complete === true && checkpoint.lower === undefined;

/** Defects in the ordering code, logged as errors rather than as an operational fallback. */
const isDefect = (error: unknown): boolean =>
  error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError;

/** What discovery and the source's `archive_channels` record say about its size. */
export const sourceWorkHint = (
  channel: GuildBasedChannel,
  record: ArchiveChannel | undefined,
  runId: string,
): SourceWorkHint => {
  const resume = resumeOf(record, runId);
  const threadMessageCount =
    'messageCount' in channel && typeof channel.messageCount === 'number'
      ? channel.messageCount
      : undefined;
  const lastMessageId =
    'lastMessageId' in channel && typeof channel.lastMessageId === 'string'
      ? channel.lastMessageId
      : undefined;
  const checkpoints = record?.checkpoints;
  return {
    id: channel.id,
    ...(threadMessageCount === undefined ? {} : { threadMessageCount }),
    ...(lastMessageId === undefined ? {} : { lastMessageId }),
    ...(resume === undefined ? {} : { resume }),
    ...(completeFullScan(checkpoints?.['full-backup']) || completeFullScan(checkpoints?.periodic)
      ? { storedComplete: true as const }
      : {}),
  };
};

/**
 * Orders a full backup's sources largest first. The stored estimate is read once
 * per scan pass with the resume cursors of its first sweep and reused by the
 * verification sweep, which may then overstate a source that advanced meanwhile;
 * that only affects order. Any failure keeps discovery order, never fails the scan.
 */
export class FullBackupSourceOrder {
  private stored: Promise<ReadonlyMap<string, StoredWork>> | undefined;

  public constructor(
    private readonly repo: Pick<ArchiveRepo, 'storedSourceWork'>,
    private readonly logger: Logger,
    private readonly scan: {
      readonly guildId: string;
      readonly runId: string;
      readonly cutoff: number;
    },
  ) {}

  /** A permutation of `channels`: largest first, sources this run finished last. */
  public async order(
    channels: readonly GuildBasedChannel[],
    records: ReadonlyMap<string, ArchiveChannel>,
    signal: AbortSignal,
  ): Promise<readonly GuildBasedChannel[]> {
    try {
      return await this.largestFirst(channels, records, signal);
    } catch (error) {
      const { guildId, runId } = this.scan;
      this.logger[isDefect(error) ? 'error' : 'warn'](
        { guildId, runId, err: error },
        'Archive full backup source order failed; keeping discovery order',
      );
      return channels;
    }
  }

  private async largestFirst(
    channels: readonly GuildBasedChannel[],
    records: ReadonlyMap<string, ArchiveChannel>,
    signal: AbortSignal,
  ): Promise<GuildBasedChannel[]> {
    const { runId, cutoff, guildId } = this.scan;
    // Sources this run completed return at once; they need no estimate.
    const finished = channels.filter(
      (channel) => fullBackupCheckpoint(records.get(channel.id), runId)?.complete === true,
    );
    const pending = channels.filter((channel) => !finished.includes(channel));
    const hints = pending.map((channel) => sourceWorkHint(channel, records.get(channel.id), runId));
    this.stored ??= this.readStored(hints, signal);
    const estimates = orderSourcesByWork(hints, await this.stored, cutoff);
    const bases: Partial<Record<SourceWorkBasis, number>> = {};
    for (const estimate of estimates) bases[estimate.basis] = (bases[estimate.basis] ?? 0) + 1;
    this.logger.info(
      {
        guildId,
        runId,
        sources: estimates.length,
        finished: finished.length,
        bases,
        largest: estimates
          .slice(0, 5)
          .map(({ id, basis, work }) => ({ id, basis, work: Math.round(work) })),
      },
      'Archive full backup source order',
    );
    const byId = new Map(pending.map((channel) => [channel.id, channel]));
    return [
      ...estimates.flatMap((estimate) => {
        const channel = byId.get(estimate.id);
        return channel === undefined ? [] : [channel];
      }),
      ...finished,
    ];
  }

  /** The stored estimate; it never rejects, an empty map leaves discovery hints alone. */
  private async readStored(
    hints: readonly SourceWorkHint[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, StoredWork>> {
    const { guildId, runId, cutoff } = this.scan;
    const started = performance.now();
    let source: StoredEstimateSource = 'none';
    let rows: StoredSourceWork[] = [];
    for (const estimate of STORED_ESTIMATES) {
      if (signal.aborted) break;
      try {
        rows = await this.repo.storedSourceWork({
          before: cutoff,
          reactions: estimate.reactions,
          maxTimeMs: estimate.maxTimeMs,
          signal,
        });
        source = estimate.source;
        rows = await this.recountResumed(rows, hints, estimate.reactions, signal);
        break;
      } catch (error) {
        this.logger.warn(
          { guildId, runId, estimate: estimate.source, err: error },
          'Archive stored source estimate failed; falling back',
        );
        // A lost connection fails the cheaper query too; skip it.
        if (
          signal.aborted ||
          isTransient(databaseErrorFrom(error, { operation: 'FullBackupSourceOrder.readStored' }))
        )
          break;
      }
    }
    this.logger.info(
      {
        guildId,
        runId,
        estimate: source,
        channels: rows.length,
        elapsedMs: Math.round(performance.now() - started),
      },
      'Archive stored source estimate',
    );
    return new Map(rows.map(({ channelId, ...work }) => [channelId, work]));
  }

  /** Replaces resumed sources' counts by what they have left; on failure keeps `rows`. */
  private async recountResumed(
    rows: StoredSourceWork[],
    hints: readonly SourceWorkHint[],
    reactions: boolean,
    signal: AbortSignal,
  ): Promise<StoredSourceWork[]> {
    const sources = new Map(
      hints.flatMap((hint) =>
        hint.resume === undefined ? [] : [[hint.id, snowflakeTimestamp(hint.resume.before)]],
      ),
    );
    if (sources.size === 0 || sources.size > RESUMED_SOURCE_LIMIT || signal.aborted) return rows;
    try {
      const resumed = await this.repo.storedSourceWork({
        before: this.scan.cutoff,
        sources,
        reactions,
        maxTimeMs: RESUMED_MAX_TIME_MS,
        signal,
      });
      return [...rows.filter((row) => !sources.has(row.channelId)), ...resumed];
    } catch (error) {
      const { guildId, runId } = this.scan;
      this.logger.warn(
        { guildId, runId, sources: sources.size, err: error },
        'Archive resumed source estimate failed; counting whole sources',
      );
      return rows;
    }
  }
}
