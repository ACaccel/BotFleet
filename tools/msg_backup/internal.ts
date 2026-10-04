/**
 * Pure, unit-testable internals for `msg_backup`. The main entry point
 * (`msg_backup.ts`) wires Discord / Mongo lifecycle, run-log files, and
 * the per-guild orchestration; the helpers here are extracted so
 * `msg_backup.test.ts` can exercise them without booting either.
 *
 * Everything here is referentially transparent given its arguments —
 * no module-level mutable state, no file I/O, no Discord/Mongo handle
 * leakage. `parseConfig` reads a file path the caller injects (tests
 * point at fixture files; the runtime entry passes the real
 * `tools/msg_backup/config.json`).
 */
import { readFileSync } from 'node:fs';

import { DiscordAPIError, type Message } from 'discord.js';

import { ConfigurationError } from '../../src/core/errors/configuration-error';

// ---------- Config ----------

export interface ToolConfig {
  readonly mongoUri: string;
  readonly discordToken: string;
  /** Local-time `YYYY-MM-DD`, or `undefined` for "no lower bound". */
  readonly startDate: string | undefined;
  readonly guilds: readonly string[];
  readonly deleteBotMessages: boolean;
  readonly batchSize: number;
}

const configError = (configPath: string, field: string, reason: string): ConfigurationError =>
  new ConfigurationError({
    code: 'INVALID_CONFIG_JSON',
    messageKey: 'errors:config.invalid',
    context: {
      operation: 'msg_backup.parseConfig',
      input: { configPath, field, reason },
    },
  });

/**
 * Parse the operator-supplied `config.json`. Path is injected so unit
 * tests can point at fixture files rather than the gitignored real
 * config. Normalises `mongo_uri` to the host-only-with-trailing-slash
 * shape `MongoConnectionManager.buildGuildMongoUri` expects: any query
 * string is stripped and a single trailing slash is re-asserted. This
 * tolerates operators pasting either `mongodb://host/` or
 * `mongodb://host/?authSource=admin` without producing a malformed URI
 * once the per-guild DB name + `?authSource=admin` is appended downstream.
 */
export const parseConfig = (configPath: string): ToolConfig => {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigurationError({
      code: 'MISSING_ENV',
      messageKey: 'errors:config.missing',
      context: {
        operation: 'msg_backup.parseConfig',
        input: { configPath, reason },
      },
      cause: err instanceof Error ? err : undefined,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    throw new ConfigurationError({
      code: 'INVALID_CONFIG_JSON',
      messageKey: 'errors:config.invalid',
      context: {
        operation: 'msg_backup.parseConfig',
        input: { configPath, reason: 'malformed JSON' },
      },
      cause: err instanceof Error ? err : undefined,
    });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw configError(configPath, '<root>', 'must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;

  const rawMongoUri = obj['mongo_uri'];
  if (typeof rawMongoUri !== 'string' || rawMongoUri.length === 0) {
    throw configError(configPath, 'mongo_uri', 'must be a non-empty string');
  }
  const mongoUriHost = rawMongoUri.split('?', 1)[0] ?? rawMongoUri;
  const mongoUri = `${mongoUriHost.replace(/\/+$/, '')}/`;

  const discordToken = obj['discord_token'];
  if (typeof discordToken !== 'string' || discordToken.length === 0) {
    throw configError(configPath, 'discord_token', 'must be a non-empty string');
  }

  const startDateRaw = obj['start_date'];
  let startDate: string | undefined;
  if (startDateRaw === undefined || startDateRaw === '') {
    startDate = undefined;
  } else if (typeof startDateRaw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startDateRaw)) {
    throw configError(configPath, 'start_date', 'must be "" or a YYYY-MM-DD string');
  } else {
    const probe = parseLocalMidnight(startDateRaw);
    if (probe === undefined) {
      throw configError(configPath, 'start_date', `"${startDateRaw}" is not a valid calendar date`);
    }
    startDate = startDateRaw;
  }

  const guildsRaw = obj['guilds'];
  if (!Array.isArray(guildsRaw) || guildsRaw.length === 0) {
    throw configError(
      configPath,
      'guilds',
      'must be a non-empty array of guild id strings (empty array fallback was removed)',
    );
  }
  const guilds: string[] = [];
  for (const g of guildsRaw) {
    if (typeof g !== 'string' || !/^\d+$/.test(g)) {
      throw configError(
        configPath,
        'guilds[]',
        `each entry must be an all-digit string, got ${String(g)}`,
      );
    }
    guilds.push(g);
  }

  const deleteBotMessagesRaw = obj['delete_bot_messages'];
  let deleteBotMessages = true;
  if (deleteBotMessagesRaw !== undefined) {
    if (typeof deleteBotMessagesRaw !== 'boolean') {
      throw configError(configPath, 'delete_bot_messages', 'must be a boolean');
    }
    deleteBotMessages = deleteBotMessagesRaw;
  }

  // Default raised from 100 → 500: with the unconditional-upsert path
  // each batch is one bulkWrite, and 500 sits at the throughput sweet
  // spot for the Mongo driver while keeping crash loss to one batch.
  const batchSizeRaw = obj['batch_size'];
  let batchSize = 500;
  if (batchSizeRaw !== undefined) {
    if (typeof batchSizeRaw !== 'number' || !Number.isInteger(batchSizeRaw) || batchSizeRaw <= 0) {
      throw configError(configPath, 'batch_size', 'must be a positive integer');
    }
    batchSize = batchSizeRaw;
  }

  return { mongoUri, discordToken, startDate, guilds, deleteBotMessages, batchSize };
};

// ---------- Time helpers (all LOCAL time) ----------

/** Parse `YYYY-MM-DD` into local-midnight epoch ms, or undefined on invalid. */
export const parseLocalMidnight = (ymd: string): number | undefined => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (m === null) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const dt = new Date(year, month, day, 0, 0, 0, 0);
  if (dt.getFullYear() !== year || dt.getMonth() !== month || dt.getDate() !== day) {
    return undefined;
  }
  return dt.getTime();
};

export const monthKey = (epochMs: number): string => {
  const d = new Date(epochMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
};

// ---------- Retry / transient classification ----------

const RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000];

const TRANSIENT_NODE_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENOTFOUND',
]);

/** HTTP statuses we consider transient on `messages.fetch`. */
const TRANSIENT_HTTP_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/**
 * Discord error codes (NOT HTTP statuses) that are definitively
 * non-transient — retrying would never help and would just waste
 * the budget. These bypass `isTransientError` entirely.
 */
const NON_TRANSIENT_DISCORD_CODES: ReadonlySet<number> = new Set([
  10003, // Unknown Channel
  10004, // Unknown Guild
  10008, // Unknown Message
  50001, // Missing Access
  50013, // Missing Permissions
  50021, // Cannot execute action on a system message
  50035, // Invalid Form Body
]);

/**
 * Heuristic for whether an error from `messages.fetch` should be
 * retried. Decision tree:
 *   1. DiscordAPIError with a code in the non-transient blacklist → never retry.
 *   2. DiscordAPIError with an HTTP status in the transient set → retry.
 *   3. Node-level error with a known transient `code` → retry.
 *   4. Otherwise → do not retry. The string-regex fallback the old
 *      implementation used is gone: matching `"timeout"` against
 *      arbitrary error messages produces too many false positives.
 */
export const isTransientError = (err: unknown): boolean => {
  if (err instanceof DiscordAPIError) {
    const codeNum = typeof err.code === 'number' ? err.code : Number(err.code);
    if (!Number.isNaN(codeNum) && NON_TRANSIENT_DISCORD_CODES.has(codeNum)) {
      return false;
    }
    return TRANSIENT_HTTP_STATUSES.has(err.status);
  }
  if (err === null || typeof err !== 'object') return false;
  const e = err as { readonly code?: unknown; readonly status?: unknown };
  if (typeof e.code === 'string' && TRANSIENT_NODE_CODES.has(e.code)) return true;
  if (typeof e.status === 'number' && TRANSIENT_HTTP_STATUSES.has(e.status)) return true;
  return false;
};

/**
 * Wrap `fn` in an exponential backoff retry loop (`RETRY_DELAYS_MS`).
 * Only `isTransientError`-positive failures are retried; everything
 * else is rethrown immediately. `onRetry` is invoked once per retry
 * with a pre-formatted log line — the orchestrator uses it to bump the
 * `retriesObserved` counter and append a `[HH:MM:SS] Retry N/3 ...`
 * line to the per-run log.
 *
 * `sleep` is injectable so unit tests can run the loop without burning
 * real wall-clock time.
 */
export const withRetry = async <T>(
  fn: () => Promise<T>,
  context: string,
  onRetry: (line: string) => void,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
): Promise<T> => {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const lastAttempt = attempt === RETRY_DELAYS_MS.length;
      if (!isTransientError(err) || lastAttempt) {
        throw err;
      }
      const delayMs = RETRY_DELAYS_MS[attempt] ?? 0;
      const reason = err instanceof Error ? err.message : String(err);
      onRetry(
        `Retry ${String(attempt + 1)}/${String(RETRY_DELAYS_MS.length)} in ` +
          `${(delayMs / 1000).toFixed(1)}s for ${context} after: ${reason}`,
      );
      await sleep(delayMs);
    }
  }
  throw new Error('msg_backup.withRetry: unreachable');
};

// ---------- buildBackfillDoc ----------

/**
 * Minimal subset of `discord.js`'s channel surface that
 * `buildBackfillDoc` actually uses. Defined here (rather than imported
 * as `GuildTextBasedChannel`) so unit tests can construct a literal
 * matching this contract without instantiating a full discord.js
 * channel.
 */
export interface BackfillChannelLike {
  readonly id: string;
  readonly name?: unknown;
}

const channelDisplayName = (channel: BackfillChannelLike): string =>
  typeof channel.name === 'string' ? channel.name : channel.id;

interface BackfillDoc {
  /**
   * Plain object to feed into `$set`. Nested arrays are OMITTED when
   * any of their elements has a critical null field. Mongo's `$set`
   * with a missing key preserves the DB-side value, so the caller's
   * `bulkWrite` is safe to apply unconditionally.
   */
  readonly doc: Record<string, unknown>;
  /** True when the corresponding nested array was suppressed. */
  readonly skipped: {
    readonly attachments: boolean;
    readonly reactions: boolean;
    readonly stickers: boolean;
  };
}

/**
 * Build the `$set` payload for one Discord `Message`.
 *
 * Top-level scalar fields (channelId, content, userId, userName,
 * timestamp, ...) are always written — Discord guarantees those for
 * any author-bearing message. The three nested arrays
 * (`attachments` / `reactions` / `stickers`) are subject to the
 * field-skip guarantee: if any element carries a critical `null`
 * (typically attachment.name on a deleted-webhook message, or a
 * sticker.name from a removed third-party pack), the **entire array
 * is omitted from the doc** so the DB-side value is preserved.
 *
 * Why omit the whole array (not just the bad element):
 *   - Mongo `$set` cannot do partial-array merge; writing a filtered
 *     subset would still overwrite the DB array and lose any
 *     elements the DB had that Discord did not return this time.
 *   - These edge messages are very rare; preserving the DB's prior
 *     (likely-also-edge) state is the safer default than substituting
 *     `''` placeholders.
 *
 * Caller has already filtered `msg.author === null`.
 */
export const buildBackfillDoc = (msg: Message, channel: BackfillChannelLike): BackfillDoc => {
  const author = msg.author;
  const doc: Record<string, unknown> = {
    channelId: channel.id,
    channelName: channelDisplayName(channel),
    content: msg.content,
    messageId: msg.id,
    userId: author.id,
    userName: author.username,
    timestamp: msg.createdTimestamp,
  };
  const skipped = { attachments: false, reactions: false, stickers: false };

  let attachmentArr: Array<Record<string, unknown>> | null = [];
  for (const a of msg.attachments.values()) {
    if (a.name === null || a.name === undefined) {
      attachmentArr = null;
      break;
    }
    attachmentArr.push({
      id: a.id,
      name: a.name,
      url: a.url,
      contentType: a.contentType ?? undefined,
    });
  }
  if (attachmentArr === null) {
    skipped.attachments = true;
  } else {
    doc['attachments'] = attachmentArr;
  }

  let reactionArr: Array<Record<string, unknown>> | null = [];
  for (const r of msg.reactions.cache.values()) {
    if (r.emoji.name === null || r.emoji.name === undefined) {
      reactionArr = null;
      break;
    }
    reactionArr.push({
      id: r.emoji.id ?? undefined,
      name: r.emoji.name,
      animated: r.emoji.animated ?? false,
      count: r.count,
      userIds: r.users.cache.map((u) => u?.id ?? '').filter((id) => id !== ''),
    });
  }
  if (reactionArr === null) {
    skipped.reactions = true;
  } else {
    doc['reactions'] = reactionArr;
  }

  let stickerArr: Array<Record<string, unknown>> | null = [];
  for (const s of msg.stickers.values()) {
    if (s.name === null || s.name === undefined) {
      stickerArr = null;
      break;
    }
    stickerArr.push({ id: s.id, name: s.name });
  }
  if (stickerArr === null) {
    skipped.stickers = true;
  } else {
    doc['stickers'] = stickerArr;
  }

  return { doc, skipped };
};

// ---------- Anomaly synthesis ----------

export interface AnomalyChannelStats {
  readonly upserted: number;
  readonly deletedBot: number;
  readonly skippedNullAuthor: number;
  readonly skippedAttachments: number;
  readonly skippedReactions: number;
  readonly skippedStickers: number;
  readonly processed: number;
}

export type ChannelOutcomeStatus =
  | 'ok'
  | 'aborted'
  | 'no-permission'
  | 'channel-not-found'
  | 'guild-not-accessible'
  | 'cursor-persist-failed'
  | 'thread-enum-failed'
  | 'retried-but-ok';

export interface ChannelOutcomeLike {
  readonly channelId: string;
  readonly channelName: string;
  readonly status: ChannelOutcomeStatus;
  readonly reason?: string;
  readonly stats: AnomalyChannelStats;
}

type AnomalyStatus =
  | 'aborted'
  | 'no-permission'
  | 'channel-not-found'
  | 'guild-not-accessible'
  | 'cursor-persist-failed'
  | 'thread-enum-failed'
  | 'retried-but-ok'
  | 'field-skip-ok';

interface AnomalyEntryOut {
  readonly status: AnomalyStatus;
  readonly channelName: string;
  readonly channelId: string;
  readonly reason: string;
  readonly partialUpserted?: number;
  readonly note?: string;
}

const STATUS_LABELS: Readonly<Record<AnomalyStatus, true>> = {
  aborted: true,
  'no-permission': true,
  'channel-not-found': true,
  'guild-not-accessible': true,
  'cursor-persist-failed': true,
  'thread-enum-failed': true,
  'retried-but-ok': true,
  'field-skip-ok': true,
};

const hasFieldSkip = (s: AnomalyChannelStats): boolean =>
  s.skippedAttachments > 0 || s.skippedReactions > 0 || s.skippedStickers > 0;

const fieldSkipNote = (s: AnomalyChannelStats): string => {
  const parts: string[] = [];
  if (s.skippedAttachments > 0) parts.push(`${String(s.skippedAttachments)} attachments`);
  if (s.skippedReactions > 0) parts.push(`${String(s.skippedReactions)} reactions`);
  if (s.skippedStickers > 0) parts.push(`${String(s.skippedStickers)} stickers`);
  return `preserved DB values on ${parts.join(', ')} (Discord returned null fields)`;
};

/**
 * Compute the per-guild Anomaly list for the summary block. Status
 * precedence: a `retried-but-ok` channel that also tripped field-skip
 * is reported as `retried-but-ok` only — transport flakiness matters
 * more to operators than per-message edge cases. A plain `ok` channel
 * with any field-skip is surfaced as `field-skip-ok` so the
 * preservation event is auditable.
 */
export const buildAnomalies = (
  outcomes: readonly ChannelOutcomeLike[],
): readonly AnomalyEntryOut[] => {
  const list: AnomalyEntryOut[] = [];
  for (const c of outcomes) {
    if (c.status === 'ok') {
      if (!hasFieldSkip(c.stats)) continue;
      list.push({
        status: 'field-skip-ok',
        channelName: c.channelName,
        channelId: c.channelId,
        reason: fieldSkipNote(c.stats),
        note: 'ok, DB values preserved on the noted fields',
      });
      continue;
    }
    if (!(c.status in STATUS_LABELS)) continue;
    const entry: AnomalyEntryOut = {
      status: c.status as AnomalyStatus,
      channelName: c.channelName,
      channelId: c.channelId,
      reason: c.reason ?? '(no reason recorded)',
      ...(c.status === 'aborted' && c.stats.upserted > 0
        ? { partialUpserted: c.stats.upserted }
        : {}),
      ...(c.status === 'retried-but-ok' ? { note: 'ok, just transient' } : {}),
    };
    list.push(entry);
  }
  return list;
};

// ---------- Thread enumeration ----------

/** discord.js `ThreadManager` page size cap for archived fetches. */
const THREAD_PAGE_LIMIT = 50;

/** The archived-thread visibility passes (gated differently by Discord). */
export type ArchivedThreadType = 'public' | 'private';

/** Which archived pass, if any, stopped early on a non-advancing cursor. */
type ArchivedPassLabel = 'archived-public' | 'archived-private';

/** Minimal thread shape needed to drive archived pagination. */
interface ThreadLike {
  readonly id: string;
  readonly archiveTimestamp?: number | null;
  readonly createdTimestamp?: number | null;
}

/** One archived-thread page, mirroring discord.js `FetchedThreadsMore`. */
interface ArchivedThreadPage<T> {
  readonly threads: Iterable<T>;
  /** Discord's authoritative "more pages remain" flag. */
  readonly hasMore: boolean;
}

/** Single guild-wide active-thread fetch (Discord returns all at once). */
export type ActiveThreadFetcher<T> = () => Promise<{ readonly threads: Iterable<T> }>;

/** Cursor-paginated archived-thread fetch for one visibility. */
export type ArchivedThreadFetcher<T> = (cursor: {
  readonly before?: number;
  readonly limit: number;
}) => Promise<ArchivedThreadPage<T>>;

interface ArchivedPaginationResult<T> {
  readonly threads: readonly T[];
  /**
   * True when Discord reported `hasMore` but the timestamp cursor could
   * not be advanced (the whole page was already seen, or no thread
   * carried a usable timestamp), so pagination stopped early and the
   * list may be incomplete. Surfaced by the caller, never dropped.
   */
  readonly truncated: boolean;
}

/**
 * Paginate one archived-thread visibility using Discord's `hasMore`
 * flag as the loop signal.
 *
 * The previous `pageSize < limit` heuristic was wrong on both ends: a
 * full page that still `hasMore` stopped early (silently missing
 * threads), and a full final page never stopped (hanging on the
 * redundant refetch). `hasMore` is authoritative. The cursor is the
 * oldest thread's `archiveTimestamp`; if it cannot advance while
 * `hasMore` is still true we stop and flag `truncated` rather than loop
 * forever.
 */
const paginateArchivedThreads = async <T extends ThreadLike>(
  fetchPage: ArchivedThreadFetcher<T>,
  onBatch: (info: {
    readonly batch: number;
    readonly size: number;
    readonly hasMore: boolean;
  }) => void,
  pageLimit: number = THREAD_PAGE_LIMIT,
): Promise<ArchivedPaginationResult<T>> => {
  const out: T[] = [];
  const seen = new Set<string>();
  let before: number | undefined;
  let batch = 0;
  while (true) {
    batch += 1;
    const page = await fetchPage(
      before !== undefined ? { before, limit: pageLimit } : { limit: pageLimit },
    );
    let size = 0;
    let newCount = 0;
    let oldestTs: number | undefined;
    for (const thread of page.threads) {
      size += 1;
      if (seen.has(thread.id)) continue;
      seen.add(thread.id);
      out.push(thread);
      newCount += 1;
      const ts = thread.archiveTimestamp ?? thread.createdTimestamp ?? undefined;
      if (ts !== null && ts !== undefined && (oldestTs === undefined || ts < oldestTs)) {
        oldestTs = ts;
      }
    }
    onBatch({ batch, size, hasMore: page.hasMore });
    if (!page.hasMore) return { threads: out, truncated: false };
    if (oldestTs === undefined || newCount === 0) {
      // Discord says more pages remain, but the cursor cannot advance.
      // Stop to avoid an infinite loop and report the truncation.
      return { threads: out, truncated: true };
    }
    before = oldestTs;
  }
};

interface ChannelThreadEnumeration<T> {
  /** Active threads (public + private the bot can see). */
  readonly active: readonly T[];
  /** Archived threads, public and private passes combined. */
  readonly archived: readonly T[];
  /**
   * Reason the archived-private pass failed, if it did. Fetching
   * archived private threads needs MANAGE_THREADS; without it the pass
   * throws. We isolate that failure so it neither silently drops the
   * private threads nor discards the active / public threads already
   * collected — the caller surfaces it as a thread-enum diagnostic.
   */
  readonly privateArchivedFailure?: string;
  /**
   * Archived passes whose pagination stopped early on a non-advancing
   * cursor (see {@link ArchivedPaginationResult.truncated}). Empty in
   * the common case; non-empty means the caller should surface a
   * partial thread-enum diagnostic.
   */
  readonly truncatedPasses: readonly ArchivedPassLabel[];
}

/**
 * Enumerate a channel's threads: one active fetch plus a public and a
 * private archived pass.
 *
 * `fetchActive` is a single call (Discord returns every active thread at
 * once, with no cursor); `fetchArchived(type)` yields the paginated
 * fetcher for one visibility, driven by {@link paginateArchivedThreads}.
 *
 * The active and archived-public passes are NOT guarded — a failure
 * there is a genuine whole-channel enumeration failure left to
 * propagate to the caller. Only archived-private is caught (it needs
 * MANAGE_THREADS); its failure is reported, not swallowed, and does not
 * discard the active / public threads already collected.
 */
export const enumerateChannelThreads = async <T extends ThreadLike>(
  fetchActive: ActiveThreadFetcher<T>,
  fetchArchived: (type: ArchivedThreadType) => ArchivedThreadFetcher<T>,
  onBatch: (
    label: ArchivedPassLabel,
    info: { readonly batch: number; readonly size: number; readonly hasMore: boolean },
  ) => void,
  pageLimit: number = THREAD_PAGE_LIMIT,
): Promise<ChannelThreadEnumeration<T>> => {
  const activePage = await fetchActive();
  const active = [...activePage.threads];

  const publicResult = await paginateArchivedThreads(
    fetchArchived('public'),
    (info) => onBatch('archived-public', info),
    pageLimit,
  );

  let privateResult: ArchivedPaginationResult<T> = { threads: [], truncated: false };
  let privateArchivedFailure: string | undefined;
  try {
    privateResult = await paginateArchivedThreads(
      fetchArchived('private'),
      (info) => onBatch('archived-private', info),
      pageLimit,
    );
  } catch (err: unknown) {
    privateArchivedFailure = err instanceof Error ? err.message : String(err);
  }

  const truncatedPasses: ArchivedPassLabel[] = [];
  if (publicResult.truncated) truncatedPasses.push('archived-public');
  if (privateResult.truncated) truncatedPasses.push('archived-private');

  return {
    active,
    archived: [...publicResult.threads, ...privateResult.threads],
    ...(privateArchivedFailure !== undefined ? { privateArchivedFailure } : {}),
    truncatedPasses,
  };
};

// ---------- discord.js ThreadManager adapters ----------
//
// Bridge the discord.js `ThreadManager` shape to the fetcher contracts
// above. Kept here (pure, given the manager) so the cursor / fetchAll
// wiring is unit-testable without a live Discord connection.

/** A discord.js collection-ish page: iterate values via `.values()`. */
interface RawThreadCollection<T> {
  values(): IterableIterator<T>;
}

export interface ThreadManagerLike<T> {
  fetchActive(cache?: boolean): Promise<{ readonly threads: RawThreadCollection<T> }>;
  fetchArchived(options: {
    readonly type: ArchivedThreadType;
    readonly fetchAll?: boolean;
    readonly before?: number;
    readonly limit?: number;
  }): Promise<{ readonly threads: RawThreadCollection<T>; readonly hasMore: boolean }>;
}

/** Single cursorless active-thread fetch. */
export const activeThreadFetcher =
  <T>(manager: ThreadManagerLike<T>): ActiveThreadFetcher<T> =>
  async () => {
    const page = await manager.fetchActive();
    return { threads: page.threads.values() };
  };

/**
 * Per-visibility archived fetcher.
 *
 * The private pass MUST pass `fetchAll: true`. Without it discord.js
 * routes to the joined-archived endpoint, which paginates by thread id
 * (snowflake) and silently ignores a timestamp `before` — so the
 * timestamp cursor never advances and the pass is stuck on page one.
 * `fetchAll: true` routes to the MANAGE_THREADS all-private endpoint,
 * which honours the timestamp cursor (and returns every archived
 * private thread, not just joined ones); a missing permission surfaces
 * as a thrown error the caller reports.
 */
export const archivedThreadFetcher =
  <T>(manager: ThreadManagerLike<T>) =>
  (type: ArchivedThreadType): ArchivedThreadFetcher<T> =>
  async (cursor) => {
    const page = await manager.fetchArchived({
      type,
      ...(type === 'private' ? { fetchAll: true } : {}),
      ...(cursor.before !== undefined ? { before: cursor.before } : {}),
      limit: cursor.limit,
    });
    return { threads: page.threads.values(), hasMore: page.hasMore };
  };
