import { Routes, type Client, type Guild, type GuildBasedChannel } from 'discord.js';
import {
  historyPermissionGap,
  isForbiddenDiscordError,
  isKnownDiscoveryGap,
  isMessageLocation,
  isPermissionGap,
  isThreadParent,
  type DiscoveryGap,
  type DiscoveryLocation,
} from '../flow/discovery';
import type { ArchivePhase } from '../flow/progress';
import { historyBefore } from '../flow/history-boundary';
import { mapArchiveChannels } from '../flow/scheduler';
import type { ArchiveHistoryCheckpoint as HistoryCheckpoint } from '../../../core/archive/types';
import type { Logger } from '../../../core/logger';
import { collectChannels } from '../internal/collect-channels';
import { ARCHIVE_LIMITS } from '../../../core/archive/limits';
import { ArchivePipelineBudget, type PipelineSnapshot } from '../flow/pipeline';

interface HistoryActivity {
  readonly step: 'fetching' | 'processing' | 'writing' | 'reactions' | 'checkpoint';
  readonly scanned?: number;
  readonly pageProcessed?: number;
  readonly pageTotal?: number;
  readonly provisional?: boolean;
}

export interface HistoryHooks {
  readonly runId: string;
  readonly cutoff: number;
  readonly full: boolean;
  /** Sources that need a full scan even when the run is incremental. */
  readonly fullChannelIds?: readonly string[];
  /** Incremental lower bounds never start after this time (see `ArchivePeriodicRun.rescanFrom`). */
  readonly rescanFrom?: number;
  readonly overlapMinutes: number;
  readonly concurrency: number;
  readonly signal: AbortSignal;
  readonly load: (
    channelId: string,
  ) => Promise<{ checkpoint?: HistoryCheckpoint; lastMessageId?: string }>;
  readonly checkpoint: (channel: GuildBasedChannel, checkpoint: HistoryCheckpoint) => Promise<void>;
  readonly consume: (
    raw: Record<string, unknown>,
    channel: GuildBasedChannel,
  ) => Promise<boolean | void>;
  readonly consumePage?: (
    raw: readonly Record<string, unknown>[],
    channel: GuildBasedChannel,
  ) => Promise<readonly (boolean | void)[]>;
  readonly pipelineBudget?: ArchivePipelineBudget;
  /** Developer comparisons may disable speculation without changing the durable consumer. */
  readonly prefetch?: boolean;
  readonly onPipeline?: (snapshot: PipelineSnapshot) => void;
  readonly onActivity?: (channelId: string, activity: HistoryActivity | undefined) => void;
  readonly completed?: (channelId: string, checkpoint: HistoryCheckpoint) => void;
  readonly fetched?: (channelId: string, count: number) => void;
  readonly afterPage: () => Promise<void>;
  readonly request: <T>(
    key: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ) => Promise<T>;
  readonly knownChannelIds?: readonly string[];
  readonly inventory?: (
    locations: readonly DiscoveryLocation[],
    gaps: readonly DiscoveryGap[],
    readableChannelIds: readonly string[],
  ) => Promise<void>;
  readonly revalidated?: (
    channelId: string,
    access: 'readable' | 'denied' | 'unknown' | 'deleted',
    channel?: GuildBasedChannel,
    reason?: string,
  ) => Promise<void>;
  readonly failed?: (reason: string) => void;
  readonly phase?: (phase: ArchivePhase) => void;
  readonly discovered?: (channelIds: readonly string[]) => void;
  /**
   * Orders one sweep's pending sources before dispatch; without it they run in
   * discovery order. A rejection, or a result that is not a permutation of its
   * input, keeps discovery order.
   */
  readonly order?: (
    channels: readonly GuildBasedChannel[],
  ) => Promise<readonly GuildBasedChannel[]>;
  readonly progress: (
    channelId: string,
    delta: number,
    checkpoint: HistoryCheckpoint,
  ) => Promise<void>;
}
interface HistoryResult {
  scanned: number;
  channels: number;
  /** Blocking failures: coverage may be recoverable by retrying the same cutoff. */
  issues: string[];
  /** Known coverage gaps (permissions, unsupported types) that retrying cannot close. */
  gaps: string[];
}
const snowflakeAt = (timestamp: number): string =>
  (BigInt(Math.max(0, Math.floor(timestamp) - 1420070400000)) << 22n).toString();
/**
 * Exclusive lower bound of an incremental source scan: the overlap window before the
 * source watermark, or before `rescanFrom` when that is earlier.
 */
export const incrementalLowerBound = (
  watermark: string,
  overlapMinutes: number,
  rescanFrom?: number,
): string => {
  const overlapMs = overlapMinutes * 60_000;
  const watermarkAt = Number(BigInt(watermark) >> 22n) + 1420070400000;
  return snowflakeAt(Math.min(watermarkAt, rescanFrom ?? watermarkAt) - overlapMs);
};

/** One sweep's sources in the order `hooks.order` gives, else in discovery order. */
const orderSources = async (
  channels: readonly GuildBasedChannel[],
  hooks: Pick<HistoryHooks, 'order' | 'signal'>,
  logger: Logger,
): Promise<readonly GuildBasedChannel[]> => {
  if (hooks.order === undefined || hooks.signal.aborted) return channels;
  try {
    const ordered = await hooks.order(channels);
    const ids = new Set(ordered.map((channel) => channel.id));
    if (ordered.length === channels.length && channels.every((channel) => ids.has(channel.id)))
      return ordered;
    logger.warn(
      { sources: channels.length, ordered: ordered.length },
      'Archive source order dropped or repeated sources; keeping discovery order',
    );
  } catch (error) {
    logger.warn({ err: error }, 'Archive source order failed; keeping discovery order');
  }
  return channels;
};

/** Backward pages use a fixed upper bound; live arrivals cannot extend the pass. */
export const scanArchiveHistory = async (
  guild: Guild,
  client: Client,
  logger: Logger,
  hooks: HistoryHooks,
): Promise<HistoryResult> => {
  const result: HistoryResult = { scanned: 0, channels: 0, issues: [], gaps: [] };
  const fullChannelIds = new Set(hooks.fullChannelIds ?? []);
  const completed = new Set<string>();
  const knownIds = new Set(hooks.knownChannelIds ?? []);
  const pipeline = hooks.pipelineBudget ?? new ArchivePipelineBudget();
  const scan = async (channel: GuildBasedChannel): Promise<void> => {
    if (hooks.signal.aborted) throw new Error('Archive scan cancelled');
    const previous = await hooks.load(channel.id);
    let checkpoint: HistoryCheckpoint =
      previous.checkpoint?.runId === hooks.runId
        ? previous.checkpoint
        : {
            runId: hooks.runId,
            cutoff: hooks.cutoff,
            before: historyBefore(new Date(hooks.cutoff)),
            complete: false,
            scanned: 0,
            pageSequence: 0,
            startedAt: Date.now(),
            ...(!hooks.full &&
            !fullChannelIds.has(channel.id) &&
            previous.lastMessageId &&
            /^\d+$/.test(previous.lastMessageId)
              ? {
                  lower: incrementalLowerBound(
                    previous.lastMessageId,
                    hooks.overlapMinutes,
                    hooks.rescanFrom,
                  ),
                }
              : {}),
          };
    if (checkpoint.cutoff !== hooks.cutoff) throw new Error('Archive resume cutoff mismatch');
    if (hooks.signal.aborted) throw new Error('Archive scan cancelled');
    if (checkpoint.complete) {
      hooks.completed?.(channel.id, checkpoint);
      return;
    }
    await hooks.checkpoint(channel, checkpoint);
    const local = new AbortController();
    const abort = (): void => local.abort();
    hooks.signal.addEventListener('abort', abort, { once: true });
    if (hooks.signal.aborted) local.abort();
    const fetchPage = async (before: string) => {
      const release = await pipeline.reserve(ARCHIVE_LIMITS.batchBytes * 2, local.signal);
      const started = Date.now();
      try {
        if (local.signal.aborted) throw new Error('Archive scan cancelled');
        const response = await hooks.request(
          `history:${channel.id}:${before}`,
          async () => {
            if (local.signal.aborted) throw new Error('Archive scan cancelled');
            return client.rest.get(Routes.channelMessages(channel.id), {
              query: new URLSearchParams({ limit: '100', before }),
              signal: local.signal,
            });
          },
          local.signal,
        );
        if (local.signal.aborted) throw new Error('Archive scan cancelled');
        if (!Array.isArray(response) || response.length > 100)
          throw new Error('Invalid Discord history response');
        const messages = response as Record<string, unknown>[];
        const bytes = Buffer.byteLength(JSON.stringify(messages), 'utf8');
        if (bytes > ARCHIVE_LIMITS.batchBytes)
          throw new Error('Archive history page exceeds byte budget');
        // Keep headroom for normalization while returning unused transport capacity to other channels.
        release.shrink(Math.max(1, bytes * 2));
        let oldest = before;
        let reachedLower = false;
        const eligible: Record<string, unknown>[] = [];
        const pageIds = new Set<string>();
        for (const raw of messages) {
          if (typeof raw.id !== 'string' || !/^\d+$/.test(raw.id))
            throw new Error('Invalid history message id');
          if (BigInt(raw.id) >= BigInt(before)) throw new Error('History cursor did not advance');
          if (pageIds.has(raw.id)) throw new Error('Duplicate history message id');
          pageIds.add(raw.id);
          if (BigInt(raw.id) < BigInt(oldest)) oldest = raw.id;
          if (checkpoint.lower !== undefined && BigInt(raw.id) <= BigInt(checkpoint.lower))
            reachedLower = true;
          else eligible.push(raw);
        }
        const done = messages.length < 100 || reachedLower;
        if (!done && oldest === before) throw new Error('History pagination stalled');
        pipeline.record('fetch', Date.now() - started, bytes);
        hooks.fetched?.(channel.id, messages.length);
        hooks.onPipeline?.(pipeline.snapshot());
        return { messages: eligible, oldest, done, release };
      } catch (error) {
        release();
        throw error;
      }
    };
    // A caught speculative result cannot escape as an unhandled rejection.
    type Page = Awaited<ReturnType<typeof fetchPage>>;
    type Fetched = { page: Page; error?: never } | { error: unknown; page?: never };
    const fetch = (before: string): Promise<Fetched> =>
      fetchPage(before).then(
        (page) => ({ page }),
        (error: unknown) => ({ error }),
      );
    let prefetched: Promise<Fetched> | undefined;
    let held: Page | undefined;
    try {
      await hooks.afterPage();
      for (;;) {
        if (local.signal.aborted) throw new Error('Archive scan cancelled');
        hooks.onActivity?.(channel.id, { step: 'fetching', scanned: checkpoint.scanned ?? 0 });
        const fetched = await (prefetched ?? fetch(checkpoint.before));
        prefetched = undefined;
        if (fetched.page === undefined) throw fetched.error;
        held = fetched.page;
        const { messages, oldest, done } = held;
        // Its predecessor bound is known, but the next page remains speculative until this barrier.
        if (!done && !local.signal.aborted && hooks.prefetch !== false) prefetched = fetch(oldest);
        hooks.onActivity?.(channel.id, {
          step: 'processing',
          pageProcessed: 0,
          pageTotal: messages.length,
          provisional: true,
          scanned: checkpoint.scanned ?? 0,
        });
        const consumeStarted = Date.now();
        let admitted = 0;
        let committed = 0;
        let latest = checkpoint.latest;
        if (hooks.consumePage !== undefined) {
          const outcomes = await hooks.consumePage(messages, channel);
          if (outcomes.length !== messages.length)
            throw new Error('Archive page outcome count mismatch');
          admitted = outcomes.filter((accepted) => accepted !== false).length;
          committed = messages.length;
        } else {
          for (const raw of messages) {
            if (local.signal.aborted) throw new Error('Archive scan cancelled');
            if ((await hooks.consume(raw, channel)) !== false) admitted += 1;
            committed += 1;
            hooks.onActivity?.(channel.id, {
              step: 'processing',
              pageProcessed: committed,
              pageTotal: messages.length,
              provisional: true,
              scanned: (checkpoint.scanned ?? 0) + committed,
            });
          }
        }
        pipeline.record('process', Date.now() - consumeStarted);
        if (local.signal.aborted) throw new Error('Archive scan cancelled');
        for (const raw of messages) {
          const id = raw.id as string;
          if (latest === undefined || BigInt(id) > BigInt(latest)) latest = id;
        }
        const next: HistoryCheckpoint = {
          ...checkpoint,
          before: oldest,
          complete: done,
          scanned: (checkpoint.scanned ?? 0) + committed,
          admitted: (checkpoint.admitted ?? 0) + admitted,
          pageAdmitted: admitted,
          pageSequence: (checkpoint.pageSequence ?? 0) + 1,
          ...(latest === undefined ? {} : { latest }),
        };
        hooks.onActivity?.(channel.id, {
          step: 'checkpoint',
          pageProcessed: committed,
          pageTotal: messages.length,
          scanned: next.scanned,
        });
        const checkpointStarted = Date.now();
        if (local.signal.aborted) throw new Error('Archive scan cancelled');
        // Durable writes and complete reaction generations form one contiguous acknowledged prefix.
        await hooks.checkpoint(channel, next);
        result.scanned += committed;
        pipeline.record('checkpoint', Date.now() - checkpointStarted);
        checkpoint = next;
        held.release();
        held = undefined;
        hooks.onPipeline?.(pipeline.snapshot());
        await hooks.progress(channel.id, committed, checkpoint);
        await hooks.afterPage();
        if (done) {
          hooks.completed?.(channel.id, checkpoint);
          return;
        }
      }
    } finally {
      local.abort();
      held?.release();
      const speculative = await prefetched;
      speculative?.page?.release();
      hooks.signal.removeEventListener('abort', abort);
      hooks.onActivity?.(channel.id, undefined);
      hooks.onPipeline?.(pipeline.snapshot());
    }
  };
  // A final inventory catches threads created or revealed during a long pass.
  for (let sweep = 0; sweep < 2; sweep += 1) {
    try {
      await hooks.afterPage();
    } catch (error) {
      if (!hooks.signal.aborted) throw error;
      break;
    }
    if (hooks.signal.aborted) break;
    hooks.phase?.(sweep === 0 ? 'discovery' : 'verification');
    const inventory = await collectChannels(guild, logger, {
      request: (key, operation) => hooks.request(key, operation, hooks.signal),
      concurrency: hooks.concurrency,
      signal: hooks.signal,
    });
    const gaps = inventory.gaps ?? [];
    for (const gap of gaps)
      (isKnownDiscoveryGap(gap) ? result.gaps : result.issues).push(
        gap.channelId === undefined ? gap.reason : `${gap.channelId}: ${gap.reason}`,
      );
    const locationMap = new Map<string, DiscoveryLocation>(
      inventory.channels.map((channel) => [
        channel.id,
        { id: channel.id, type: channel.type, source: channel },
      ]),
    );
    for (const location of inventory.locations ?? []) locationMap.set(location.id, location);
    const locations = [...locationMap.values()];
    await hooks.inventory?.(
      locations,
      gaps,
      inventory.channels.map((channel) => channel.id),
    );
    const present = new Set(locations.map((location) => location.id));
    for (const location of locations) knownIds.add(location.id);
    const discoveredChannels = new Map(inventory.channels.map((channel) => [channel.id, channel]));
    for (const channelId of knownIds) {
      if (present.has(channelId) || hooks.signal.aborted) continue;
      try {
        if (!/^\d+$/.test(channelId)) throw new Error('invalid-prior-channel-id');
        const channel = await hooks.request(`discovery:known:${channelId}:${sweep}`, () =>
          client.channels.fetch(channelId, { force: true }),
        );
        if (channel === null || !('guild' in channel) || channel.guild.id !== guild.id)
          throw new Error('known-channel-not-materialized-in-guild');
        if (isThreadParent(channel))
          result.issues.push(
            `${channelId}: known-thread-parent-missing-from-inventory; archived-thread discovery unresolved`,
          );
        if (!isMessageLocation(channel)) {
          if (typeof channel.type !== 'number' || ![4, 14, 15, 16].includes(channel.type))
            result.gaps.push(`${channelId}: unsupported-known-channel-type`);
          await hooks.revalidated?.(channelId, 'unknown', channel);
          continue;
        }
        const reason = historyPermissionGap(channel);
        if (reason !== undefined) {
          (isPermissionGap(reason) ? result.gaps : result.issues).push(`${channelId}: ${reason}`);
          await hooks.revalidated?.(channelId, 'denied', channel, reason);
          continue;
        }
        if (!('messages' in channel)) throw new Error('known-message-channel-unreadable');
        discoveredChannels.set(channelId, channel);
        await hooks.revalidated?.(channelId, 'readable', channel);
      } catch (error) {
        if (hooks.signal.aborted) break;
        const code = (error as { code?: unknown } | null)?.code;
        if (code === 10003) {
          knownIds.delete(channelId);
          await hooks.revalidated?.(channelId, 'deleted', undefined, 'discord-unknown-channel');
          continue;
        }
        const denied = isForbiddenDiscordError(error);
        const reason = String(error);
        (denied ? result.gaps : result.issues).push(`${channelId}: ${reason}`);
        await hooks.revalidated?.(channelId, denied ? 'denied' : 'unknown', undefined, reason);
      }
    }
    hooks.discovered?.([...discoveredChannels.keys()]);
    const unfinished = [...discoveredChannels.values()].filter(
      (channel) => !completed.has(channel.id),
    ) as GuildBasedChannel[];
    const pending = await orderSources(unfinished, hooks, logger);
    hooks.phase?.('history');
    await mapArchiveChannels(
      pending,
      async (channel) => {
        if (hooks.signal.aborted) return;
        try {
          await scan(channel);
          completed.add(channel.id);
          result.channels += 1;
        } catch (error) {
          result.issues.push(`${channel.id}: ${String(error)}`);
          hooks.failed?.(String(error));
        }
      },
      hooks.concurrency,
    );
    if (hooks.signal.aborted) break;
  }
  hooks.phase?.('verification');
  result.issues = [...new Set(result.issues)];
  result.gaps = [...new Set(result.gaps)];
  return result;
};
