/**
 * In-process file-routing sink for pino: each JSON Lines record goes to a
 * file chosen from its `bot` / `guildId` bindings, rotating at local
 * midnight.
 *
 * The sink is a `Writable` in a {@link import('pino').multistream}, not a
 * worker-thread transport, and that is deliberate: it shares the bot's event
 * loop so `installProcessHandlers` can close every cached fd on the same tick
 * during shutdown, and `pino-abstract-transport` needs a JS worker entry point
 * that is awkward under `ts-node`.
 *
 * Routing: records with `guildId` go to
 * `<rootDir>/<bot>/<guildId>/<YYYY-MM-DD>.log`; others to
 * `<rootDir>/<bot>/<YYYY-MM-DD>.log`.
 *
 * Every record MUST carry `bot` (the composition root binds it). A record
 * without it throws synchronously; there is deliberately no fallback file,
 * which would hide the mis-binding. `bot` is stripped from the record because
 * the directory already names it; `guildId` stays as a join key for
 * downstream aggregators that never see the file path.
 *
 * `time` stays pino's UTC ISO so files read unambiguously across time zones;
 * only file selection uses local time. When `retentionDays` is set the stream
 * also runs {@link startLogRetention} over `rootDir`.
 */
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';

import type { StreamEntry } from 'pino';

import { startLogRetention, type LogRetention } from './log-retention';

interface FileRouterOptions {
  /** Root directory under which `<botId>[/<guildId>]/<date>.log` lives. */
  readonly rootDir: string;
  /**
   * Delete dated log files older than this many local days, once at
   * start and then daily, for as long as the stream is open. Omitted or
   * `0` disables retention.
   */
  readonly retentionDays?: number;
}

interface CachedStream {
  /** `YYYY-MM-DD` of the local-time day the stream was opened on. */
  date: string;
  stream: WriteStream;
}

/**
 * Format a `Date` as `YYYY-MM-DD` using the operator's local timezone.
 * `getMonth()` is 0-based so the `+1` is intentional.
 */
const localDateKey = (now: Date): string => {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const targetFilePath = (
  rootDir: string,
  botId: string,
  guildId: string | undefined,
  date: string,
): string => {
  if (guildId !== undefined && guildId.length > 0) {
    return join(rootDir, botId, guildId, `${date}.log`);
  }
  return join(rootDir, botId, `${date}.log`);
};

const cacheKey = (botId: string, guildId: string | undefined): string => {
  const guild = guildId !== undefined && guildId.length > 0 ? guildId : '';
  return `${botId}|${guild}`;
};

/**
 * Report a file-sink failure on stderr.
 *
 * Deliberately not routed through the logger: the logger is the thing
 * that just failed, so re-entering it would either loop or drop the
 * report. stderr is the one sink that is still available.
 */
/**
 * How long a failed sink target is left alone before the next record
 * tries to reopen it.
 */
const SINK_RETRY_COOLDOWN_MS = 60_000;

const reportSinkFailure = (filePath: string, err: unknown): void => {
  const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  process.stderr.write(
    `file-router-transport: log sink ${filePath} failed (${reason}); ` +
      'continuing without it. Records still reach the other configured streams.\n',
  );
};

/**
 * Open an append stream, routing its `'error'` event to `onError`.
 *
 * A disk-level failure (ENOSPC, EACCES, an unmounted volume) surfaces
 * as an `'error'` event. With no listener Node rethrows it as an
 * `uncaughtException`, which `installProcessHandlers` classifies as
 * fatal — a full disk would take the whole bot down. Attaching a
 * listener is what turns that into a degraded file sink.
 */
const reportRetentionFailure = (path: string, err: unknown, failures: number): void => {
  const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  process.stderr.write(
    `file-router-transport: log retention failed at ${path} (${reason}); ` +
      `${failures} failure(s) this pass. Retrying at the next scheduled pass.\n`,
  );
};

const openStream = (filePath: string, onError: (err: Error) => void): WriteStream => {
  mkdirSync(dirname(filePath), { recursive: true });
  const stream = createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
  stream.on('error', onError);
  return stream;
};

const endStreamAsync = (stream: WriteStream): Promise<void> =>
  new Promise<void>((resolve) => {
    // Resolve on `close` unconditionally; an already-errored stream
    // would otherwise stall shutdown waiting for a callback that will
    // never fire.
    stream.once('close', () => {
      resolve();
    });
    stream.end();
  });

/**
 * Build a pino-compatible `Writable` that routes each JSON Lines
 * record to a per-(bot,guild) file with local-date rotation. Pass
 * the returned stream into `pino.multistream(...)` alongside any
 * other targets (pretty console, alternate sinks).
 *
 * The stream receives whatever `pino.multistream` writes — by default
 * a single JSON Lines string per record, no trailing partial line. We
 * split defensively on `\n` to tolerate batched writes from future
 * pino versions that might coalesce multiple records into one chunk.
 */
export const createFileRouterStream = (options: FileRouterOptions): Writable => {
  if (typeof options.rootDir !== 'string' || options.rootDir.length === 0) {
    throw new Error(
      'file-router-transport: rootDir option is required and must be a non-empty string',
    );
  }
  const rootDir = options.rootDir;
  const cache = new Map<string, CachedStream>();
  /**
   * Cache key -> earliest time the sink may retry it. A persistent
   * failure (ENOSPC, a revoked mount) would otherwise re-open the file
   * and re-report on *every* record, turning one disk problem into an
   * unbounded stderr flood at log volume.
   */
  const retryAfter = new Map<string, number>();
  // Buffer for partial lines (defensive; pino writes complete lines).
  let pending = '';
  // Owned by the stream so closing the sink also stops the schedule; the
  // timer is unref'd and must never outlive `final` / `destroy`.
  const retention: LogRetention | undefined =
    options.retentionDays !== undefined && options.retentionDays > 0
      ? startLogRetention({
          rootDir,
          retentionDays: options.retentionDays,
          onFailure: reportRetentionFailure,
        })
      : undefined;

  const writeRecord = (line: string): void => {
    if (line.length === 0) return;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch (parseErr) {
      // A malformed JSON line is a contract violation — pino emits
      // well-formed records by construction and the only writer for
      // this stream is pino. Surfacing the error loudly is preferable
      // to silently shuttling junk into a fallback file.
      throw new Error(
        `file-router-transport: failed to parse JSON record: ${(parseErr as Error).message}`,
      );
    }
    const botId = typeof obj['bot'] === 'string' ? (obj['bot'] as string) : undefined;
    if (botId === undefined || botId.length === 0) {
      // The composition root binds `{ bot: clientId }` on the root
      // logger; every child inherits it. A record arriving here without
      // `bot` means the file sink was wired without the binding — a
      // setup bug we want to surface immediately so the operator fixes
      // it rather than chase a hidden `_unbound` directory later.
      throw new Error(
        'file-router-transport: record is missing required `bot` binding; ' +
          'the composition root must call createLogger with `base: { bot: <clientId> }`.',
      );
    }
    const guildId = typeof obj['guildId'] === 'string' ? (obj['guildId'] as string) : undefined;
    const cached = openOrRefresh(botId, guildId);
    // The file sink is degraded (the target could not be opened); the
    // failure is already on stderr and the other configured streams
    // still carry this record.
    if (cached === undefined) return;
    // `bot` is path-encoded (the parent directory names the bot), so
    // strip it from the JSON record before serialising. `guildId` stays
    // — cross-guild aggregators key on it without seeing the file path.
    // Re-serialising rather than string-splicing the original `line`
    // is the only correct path: pino emits records with no canonical
    // field order, and JSON.parse + JSON.stringify is the
    // straightforward way to drop a key without writing a fragile
    // regex over the source string.
    const { bot: _stripped, ...rest } = obj;
    void _stripped;
    cached.stream.write(`${JSON.stringify(rest)}\n`);
  };

  /**
   * Return the cached stream for `(bot, guild)`, opening or rotating it
   * as needed. Returns `undefined` when the target cannot be opened —
   * the sink degrades rather than propagating a disk failure into the
   * caller's write path.
   */
  const openOrRefresh = (botId: string, guildId: string | undefined): CachedStream | undefined => {
    const key = cacheKey(botId, guildId);
    const date = localDateKey(new Date());
    const existing = cache.get(key);
    if (existing !== undefined && existing.date === date) {
      return existing;
    }
    const backoffUntil = retryAfter.get(key);
    if (backoffUntil !== undefined && Date.now() < backoffUntil) return undefined;
    if (existing !== undefined) {
      // Day rolled over — fire-and-forget close the prior stream.
      void endStreamAsync(existing.stream);
      cache.delete(key);
    }
    const filePath = targetFilePath(rootDir, botId, guildId, date);
    let fresh: CachedStream;
    try {
      fresh = {
        date,
        // The `'error'` listener fires asynchronously, so `fresh` is
        // always assigned by the time this closure runs.
        stream: openStream(filePath, (err) => {
          reportSinkFailure(filePath, err);
          retryAfter.set(key, Date.now() + SINK_RETRY_COOLDOWN_MS);
          // Evict only if this is still the live entry: a day rollover
          // may already have replaced it, and dropping the successor
          // would lose a healthy stream.
          if (cache.get(key) === fresh) cache.delete(key);
        }),
      };
    } catch (err: unknown) {
      // `mkdirSync` / `createWriteStream` throw synchronously on a
      // permission or space failure.
      reportSinkFailure(filePath, err);
      retryAfter.set(key, Date.now() + SINK_RETRY_COOLDOWN_MS);
      return undefined;
    }
    cache.set(key, fresh);
    return fresh;
  };

  return new Writable({
    decodeStrings: false,
    write(chunk: string | Buffer, _enc, cb): void {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      pending += text;
      try {
        let idx = pending.indexOf('\n');
        while (idx !== -1) {
          const line = pending.slice(0, idx);
          pending = pending.slice(idx + 1);
          writeRecord(line);
          idx = pending.indexOf('\n');
        }
      } catch (err: unknown) {
        // Surface contract violations (missing `bot` binding, malformed
        // JSON) through the Writable `error` event so downstream
        // observers can react without the throw bubbling out of pino's
        // sync write path and crashing the process.
        cb(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      cb();
    },
    destroy(err, cb): void {
      // `destroy` skips `final`, so stop the schedule here too.
      retention?.stop();
      cb(err);
    },
    final(cb): void {
      // Drain any trailing partial line, then close every cached
      // stream. `Promise.all` is awaited inline so the pino flush path
      // sees a clean shutdown.
      retention?.stop();
      if (pending.length > 0) {
        writeRecord(pending);
        pending = '';
      }
      const streams = Array.from(cache.values()).map((c) => c.stream);
      cache.clear();
      Promise.all(streams.map((s) => endStreamAsync(s)))
        .then(() => {
          cb();
        })
        .catch((err: unknown) => {
          cb(err instanceof Error ? err : new Error(String(err)));
        });
    },
  });
};

/**
 * Composition-root-facing factory. Build a {@link StreamEntry} suitable
 * for `createLogger({ extraStreams: [createFileSink({ rootDir, level })] })`.
 *
 * Kept separate from {@link createFileRouterStream} so the composition
 * root has a single, opt-in entry point that returns the exact shape
 * `createLogger` expects (a `StreamEntry`, not a bare `Writable`).
 * `core/logger/logger.ts` does NOT import this — callers wire it from
 * outside the logger module so `createLogger` itself stays free of
 * file-system concerns.
 */
export const createFileSink = (options: {
  readonly rootDir: string;
  readonly level: StreamEntry['level'];
  readonly retentionDays?: number;
}): StreamEntry => ({
  level: options.level,
  stream: createFileRouterStream({
    rootDir: options.rootDir,
    ...(options.retentionDays !== undefined ? { retentionDays: options.retentionDays } : {}),
  }),
});

/**
 * Build a pino-compatible `Writable` that appends every record it
 * receives to a single fixed file path. Unlike
 * {@link createFileRouterStream}, no `bot` / `guildId` routing happens
 * — every line lands in the same file. The pino multistream `level`
 * filter is the gate that decides which records reach this sink.
 *
 * Designed for the ops-tool use case where the operator wants a
 * dedicated `error.log` that they can `cat` directly without
 * filtering a per-day routed log. Pair it with `level: 'error'` on
 * the {@link StreamEntry} so only `error` / `fatal` records arrive.
 *
 * Records are written verbatim — no field stripping, no JSON
 * re-serialisation. The router's `bot`-stripping behaviour is
 * specific to its path-encoding contract; a flat append sink has no
 * such contract.
 */
export const createFixedPathFileStream = (filePath: string): Writable => {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error(
      'file-router-transport: filePath option is required and must be a non-empty string',
    );
  }
  mkdirSync(dirname(filePath), { recursive: true });
  const stream = createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
  // Same degrade policy as the routed sink: report a disk failure on
  // stderr instead of letting the unhandled `'error'` event escalate to
  // a fatal `uncaughtException`.
  stream.on('error', (err) => {
    reportSinkFailure(filePath, err);
  });
  return new Writable({
    decodeStrings: false,
    write(chunk: string | Buffer, _enc, cb): void {
      // One callback, invoked exactly once by Node when the chunk is
      // flushed or the write fails, and it doubles as the backpressure
      // signal. The failure itself is reported by the `'error'` listener
      // above, so the callback completes the write unconditionally: a
      // failed log write must not fail the logger that produced it.
      stream.write(chunk, () => {
        cb();
      });
    },
    final(cb): void {
      stream.once('close', () => {
        cb();
      });
      stream.end();
    },
  });
};
