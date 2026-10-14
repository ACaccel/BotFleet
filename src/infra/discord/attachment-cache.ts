/**
 * Pre-delete attachment cache.
 *
 * Discord purges an attachment's CDN object almost as soon as its message is
 * deleted, so a download started from `messageDelete` usually loses the
 * race. This module downloads attachments on message create and, at delete
 * time, moves the cached copy into the archive tree instead of using the
 * network.
 *
 * The layout `<cacheRoot>/<guildId>/<messageId>/<attachmentId>-<name>` lets
 * a single or bulk deletion find its files with one `readdir`.
 *
 * Privacy: a copy of every recent attachment sits on the bot host until the
 * TTL sweep removes it; see the `permission_rank` note in
 * `docs/architecture.md`.
 *
 * New entries stop while free space is under the configured floor, but
 * delete-time paths are never gated: declining to archive loses evidence
 * outright. Every operation swallows its own failures so caching never
 * disturbs the message flow.
 */
import type { Attachment } from 'discord.js';
import fs from 'fs';
import path from 'path';

import type { Logger } from '../../core/logger';

import {
  archiveFilePath,
  downloadToFile,
  publishFile,
  runBounded,
  sanitizeFileName,
  PARTIAL_SUFFIX,
} from './attachment-io';

/** Root of the cache tree. `data/` is gitignored. */
const DEFAULT_CACHE_ROOT = './data/attachment_cache';

const MS_PER_HOUR = 60 * 60 * 1000;

/** The floor is configured in MiB; `statfs` reports bytes. */
const BYTES_PER_MIB = 1024 * 1024;

/**
 * Free-space probe over the cache volume — the slice of
 * `fs.promises.statfs` this module reads. A seam rather than a direct
 * call so a test can drive the floor without a genuinely full disk.
 */
type StatfsProbe = (path: string) => Promise<{ readonly bavail: number; readonly bsize: number }>;

/** Where the free-space check last left the cache. */
type SpaceState = 'ok' | 'paused' | 'unverifiable';

interface AttachmentCacheOptions {
  /** How long a cached message directory survives, in hours. */
  readonly ttlHours: number;
  /** Free space the cache volume must keep, in MiB, to accept new entries. */
  readonly minFreeDiskMb: number;
  readonly logger?: Logger;
  /** Cache tree root. Overridden by tests; production uses the default. */
  readonly cacheRoot?: string;
  /** Archive tree root moved into. Defaults to the archive's own root. */
  readonly archiveRoot?: string;
  /** Free-space probe. Overridden by tests; production uses `statfs`. */
  readonly statfs?: StatfsProbe;
}

export interface AttachmentCache {
  /**
   * Download and cache one message's attachments. Does nothing while
   * the cache volume sits below its free-space floor. Never rejects.
   */
  store(guildId: string, messageId: string, attachments: Iterable<Attachment>): Promise<void>;
  /**
   * Move a message's cached attachments into the forensic archive and
   * drop its cache entry. Returns how many files were archived — `0`
   * means a cache miss and tells the caller to try the network.
   *
   * Waits for an in-flight {@link store} of the same message first: a
   * deletion can land mid-download, and reading the directory early
   * would archive a prefix of the attachments and report it as a full
   * hit. Never rejects.
   */
  archiveCached(guildId: string, messageId: string): Promise<number>;
  /** Delete cache entries older than the TTL. Returns how many were removed. */
  sweepExpired(nowMs: number): Promise<number>;
}

/**
 * Recover the uploaded name from an `<attachmentId>-<name>` entry.
 * The id is a Discord snowflake, so anchoring on digits stops an upload
 * name that itself contains a hyphen from being truncated. An entry
 * that does not match keeps its whole name — a clumsy archive file
 * beats a lost one.
 */
const CACHE_ENTRY_PATTERN = /^\d+-(.+)$/;
const originalNameOf = (entry: string): string => CACHE_ENTRY_PATTERN.exec(entry)?.[1] ?? entry;

/**
 * Directory listing that reports an absent directory as empty — the
 * ordinary cache-miss case — and re-raises anything else. A blanket
 * swallow here would turn an unreadable cache tree into a permanent
 * silent "nothing to do", which is precisely how the sweep stops
 * bounding disk use without anyone noticing.
 */
const readdirIfPresent = async (dir: string): Promise<string[]> => {
  try {
    return await fs.promises.readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
};

/** Entries a reader may act on: a `.part` file is still being written. */
const completeEntries = (entries: readonly string[]): string[] =>
  entries.filter((entry) => !entry.endsWith(PARTIAL_SUFFIX));

export const createAttachmentCache = (options: AttachmentCacheOptions): AttachmentCache => {
  const cacheRoot = options.cacheRoot ?? DEFAULT_CACHE_ROOT;
  const archiveRoot = options.archiveRoot;
  const logger = options.logger;
  const ttlMs = options.ttlHours * MS_PER_HOUR;
  const minFreeBytes = options.minFreeDiskMb * BYTES_PER_MIB;
  const statfs: StatfsProbe = options.statfs ?? fs.promises.statfs;

  /**
   * Free-space verdict of the last {@link store}. Held so the operator
   * gets one line when caching pauses and one when it resumes, instead
   * of one per skipped attachment — a full volume affects every message,
   * and the flood would bury the very line worth reading.
   */
  let spaceState: SpaceState = 'ok';

  /**
   * In-flight {@link store} calls, keyed by guild + message, so a
   * deletion arriving mid-download waits for the bytes instead of
   * archiving a prefix of them.
   */
  const pending = new Map<string, Promise<void>>();

  const messageDir = (guildId: string, messageId: string): string =>
    path.join(cacheRoot, guildId, messageId);

  /**
   * Available bytes on the volume holding the cache root.
   *
   * Before the first write the root does not exist yet, and a mount
   * point has to exist to be one — so the nearest existing ancestor is
   * on exactly the volume the first write lands on. Walking up is what
   * keeps a fresh install from reporting its floor as unverifiable.
   *
   * @throws when the volume cannot be inspected for any other reason.
   */
  const availableBytes = async (): Promise<number> => {
    let candidate = path.resolve(cacheRoot);
    for (;;) {
      try {
        // POSIX defines free bytes as `f_bavail * f_frsize`, but Node's
        // `StatsFs` exposes no `frsize`; the two agree on every
        // filesystem this runs on, so `bsize` is the available stand-in.
        const stats = await statfs(candidate);
        return stats.bavail * stats.bsize;
      } catch (e) {
        const parent = path.dirname(candidate);
        // The probe is an injected seam, so its rejection value is not
        // guaranteed to be an `Error` at all: check before reading the
        // code, or a non-Error rejection throws from inside the catch.
        const absent = e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT';
        if (!absent || parent === candidate) throw e;
        candidate = parent;
      }
    }
  };

  /** Log a free-space transition once, on the edge that crossed it. */
  const enterState = (next: SpaceState, log: () => void): void => {
    if (spaceState === next) return;
    spaceState = next;
    log();
  };

  /**
   * Whether the volume has room to accept new cache entries.
   *
   * An unreadable volume answers yes. The floor is best-effort
   * protection against filling a disk, not evidence that one is full,
   * and refusing to cache on a failed probe would trade a suspected
   * problem for a certain loss of attachments.
   */
  const hasRoomForNewEntries = async (): Promise<boolean> => {
    let available: number;
    try {
      available = await availableBytes();
    } catch (e) {
      enterState('unverifiable', () => {
        logger?.warn(
          { err: e instanceof Error ? e : new Error(String(e)), cacheRoot, minFreeBytes },
          'attachmentCache: could not read free space; caching continues unchecked',
        );
      });
      return true;
    }

    if (available < minFreeBytes) {
      enterState('paused', () => {
        logger?.warn(
          { cacheRoot, availableBytes: available, minFreeBytes },
          'attachmentCache: free space below the floor; caching paused',
        );
      });
      return false;
    }

    const resumed = spaceState === 'paused';
    enterState('ok', () => {
      logger?.info(
        { cacheRoot, availableBytes: available, minFreeBytes },
        resumed
          ? 'attachmentCache: free space back above the floor; caching resumed'
          : 'attachmentCache: free space readable again; the floor is being enforced',
      );
    });
    return true;
  };

  const moveIntoArchive = async (
    guildId: string,
    messageId: string,
    source: string,
    name: string,
  ): Promise<void> => {
    const destination = archiveFilePath(guildId, messageId, name, archiveRoot);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await publishFile(source, destination);
  };

  const download = async (
    guildId: string,
    messageId: string,
    attachments: Iterable<Attachment>,
  ): Promise<void> => {
    const dir = messageDir(guildId, messageId);
    try {
      // Checked before the first byte and before the directory exists,
      // so a volume under the floor gains nothing at all from this
      // message. Inside the try, so this function keeps the "never
      // rejects" contract `store` and `archiveCached` both rely on.
      if (!(await hasRoomForNewEntries())) return;

      await runBounded(attachments, async (attachment) => {
        const entry = `${sanitizeFileName(attachment.id)}-${sanitizeFileName(attachment.name)}`;
        const failure = await downloadToFile(attachment.url, path.join(dir, entry));
        if (failure === undefined) return;
        logger?.warn(
          {
            err: failure.error,
            stage: failure.stage,
            status: failure.status,
            guildId,
            messageId,
            name: attachment.name,
          },
          'attachmentCache: could not cache an attachment',
        );
      });
    } catch (e) {
      logger?.warn(
        { err: e instanceof Error ? e : new Error(String(e)), guildId, messageId },
        'attachmentCache: caching a message failed',
      );
    }
  };

  const store = async (
    guildId: string,
    messageId: string,
    attachments: Iterable<Attachment>,
  ): Promise<void> => {
    const key = `${guildId}/${messageId}`;
    // Registered before the first suspension point, so a deletion that
    // arrives later always finds the entry.
    const task = download(guildId, messageId, attachments);
    pending.set(key, task);
    try {
      await task;
    } finally {
      pending.delete(key);
    }
  };

  const archiveCached = async (guildId: string, messageId: string): Promise<number> => {
    const inFlight = pending.get(`${guildId}/${messageId}`);
    // `download` swallows its own failures, so this cannot reject.
    if (inFlight !== undefined) await inFlight;

    const dir = messageDir(guildId, messageId);
    let entries: string[];
    try {
      entries = completeEntries(await readdirIfPresent(dir));
    } catch (e) {
      // An unreadable cache entry is not a miss. Say so, and report 0 so
      // the caller still tries the network rather than losing the file
      // to a silent "nothing cached".
      logger?.warn(
        { err: e instanceof Error ? e : new Error(String(e)), guildId, messageId },
        'attachmentCache: could not read a cache entry',
      );
      return 0;
    }
    if (entries.length === 0) return 0;

    let moved = 0;
    for (const entry of entries) {
      try {
        await moveIntoArchive(guildId, messageId, path.join(dir, entry), originalNameOf(entry));
        moved += 1;
      } catch (e) {
        logger?.warn(
          { err: e instanceof Error ? e : new Error(String(e)), guildId, messageId, entry },
          'attachmentCache: could not move a cached attachment into the archive',
        );
      }
    }

    // Drop the entry only once every file made it out; a leftover is
    // better than a deletion, and the TTL sweep collects it either way.
    if (moved === entries.length) {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    return moved;
  };

  const sweepExpired = async (nowMs: number): Promise<number> => {
    const cutoff = nowMs - ttlMs;
    let removed = 0;
    for (const guildId of await readdirIfPresent(cacheRoot)) {
      const guildDir = path.join(cacheRoot, guildId);
      for (const messageId of await readdirIfPresent(guildDir)) {
        const dir = path.join(guildDir, messageId);
        try {
          const stats = await fs.promises.stat(dir);
          if (stats.mtimeMs >= cutoff) continue;
          await fs.promises.rm(dir, { recursive: true, force: true });
          removed += 1;
        } catch (e) {
          logger?.warn(
            { err: e instanceof Error ? e : new Error(String(e)), guildId, messageId },
            'attachmentCache: could not sweep an expired cache entry',
          );
        }
      }
      // Collect the guild directory once its last entry expired, so the
      // tree does not accumulate empty folders forever. Fails harmlessly
      // while entries remain.
      await fs.promises.rmdir(guildDir).catch(() => undefined);
    }
    return removed;
  };

  return { store, archiveCached, sweepExpired };
};
