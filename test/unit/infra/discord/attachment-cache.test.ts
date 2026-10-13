/**
 * The pre-delete attachment cache.
 *
 * Everything runs against a tmpdir so no case touches the repository's
 * `data/` tree, and `axios` is mocked so no case touches the network.
 *
 * The behaviours worth pinning are the ones the delete path depends on:
 * a cached message can be archived without a single request, a miss is
 * reported as `0` so the caller still tries the network, and the TTL
 * sweep removes expired entries only.
 *
 * The free-space probe is injected in every case, so no assertion
 * depends on how much room the machine running the suite happens to
 * have — and the floor cases can describe a full volume without one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'node:stream';

import { createAttachmentCache } from '../../../../src/infra/discord';
import type { Logger } from '../../../../src/core/logger';

vi.mock('axios');

const fakeLogger = (): Logger =>
  ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => fakeLogger()),
  }) as unknown as Logger;

const setAxiosGet = (impl: (...args: unknown[]) => unknown): void => {
  (axios.get as unknown as ReturnType<typeof vi.fn>) = vi.fn(impl);
};

/** Discord attachment ids are snowflakes; the cache layout relies on that. */
const attachment = (id: string, name: string): never =>
  ({ id, name, url: `https://cdn.invalid/${id}/${name}` }) as never;

const A1 = '1300000000000000001';
const A2 = '1300000000000000002';

const HOUR_MS = 60 * 60 * 1000;
const MB = 1024 * 1024;

/** Typical filesystem block size; `statfs` reports free space in blocks. */
const BLOCK_SIZE = 4096;

/** Floor used by the cases that are not about the floor. */
const FLOOR_MB = 100;

/** A volume reporting whatever `bytes()` says free at probe time. */
const volume = (bytes: () => number) => (): Promise<{ bavail: number; bsize: number }> =>
  Promise.resolve({ bavail: Math.floor(bytes() / BLOCK_SIZE), bsize: BLOCK_SIZE });

/** A volume whose free space never moves. */
const volumeWith = (bytes: number): ReturnType<typeof volume> => volume(() => bytes);

const warnCalls = (logger: Logger): unknown[][] =>
  (logger.warn as unknown as ReturnType<typeof vi.fn>).mock.calls;

const infoCalls = (logger: Logger): unknown[][] =>
  (logger.info as unknown as ReturnType<typeof vi.fn>).mock.calls;

describe('createAttachmentCache', () => {
  let root: string;
  let cacheRoot: string;
  let archiveRoot: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-cache-'));
    cacheRoot = path.join(root, 'attachment_cache');
    archiveRoot = path.join(root, 'deleted_attachments');
    setAxiosGet(async () => ({ data: Readable.from(['bytes']) }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** The cache under test, with every collaborator defaulted for tests. */
  const makeCache = (
    overrides: Partial<Parameters<typeof createAttachmentCache>[0]> = {},
  ): ReturnType<typeof createAttachmentCache> =>
    createAttachmentCache({
      ttlHours: 24,
      minFreeDiskMb: FLOOR_MB,
      cacheRoot,
      archiveRoot,
      logger: fakeLogger(),
      statfs: volumeWith(10 * FLOOR_MB * MB),
      ...overrides,
    });

  const cacheWith = (ttlHours = 24): ReturnType<typeof createAttachmentCache> =>
    makeCache({ ttlHours });

  const messageDir = (guildId: string, messageId: string): string =>
    path.join(cacheRoot, guildId, messageId);

  const listOrEmpty = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

  const archivedFiles = (guildId: string, messageId: string): string[] =>
    listOrEmpty(path.join(archiveRoot, guildId, messageId));

  describe('store', () => {
    it('writes each attachment under <guild>/<message>/<attachmentId>-<name>', async () => {
      await cacheWith().store('g-1', 'm-1', [attachment(A1, 'pic.png'), attachment(A2, 'n.txt')]);

      expect(listOrEmpty(messageDir('g-1', 'm-1')).sort()).toEqual([
        `${A1}-pic.png`,
        `${A2}-n.txt`,
      ]);
      expect(fs.readFileSync(path.join(messageDir('g-1', 'm-1'), `${A1}-pic.png`), 'utf8')).toBe(
        'bytes',
      );
    });

    it('swallows a download failure so a bad attachment never disturbs the message flow', async () => {
      const logger = fakeLogger();
      setAxiosGet(async () => {
        throw new Error('cdn refused');
      });

      await expect(
        makeCache({ logger }).store('g-1', 'm-1', [attachment(A1, 'pic.png')]),
      ).resolves.toBeUndefined();

      expect(warnCalls(logger).length).toBe(1);
      expect(listOrEmpty(messageDir('g-1', 'm-1'))).toEqual([]);
    });

    it('keeps a hostile file name inside the cache directory', async () => {
      await cacheWith().store('g-1', 'm-1', [attachment(A1, '../../escaped.png')]);

      expect(listOrEmpty(messageDir('g-1', 'm-1'))).toEqual([`${A1}-escaped.png`]);
    });
  });

  describe('archiveCached', () => {
    it('moves a cached message into the archive without any network call', async () => {
      const cache = cacheWith();
      await cache.store('g-1', 'm-1', [attachment(A1, 'pic.png')]);
      const callsAfterStore = (axios.get as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

      const moved = await cache.archiveCached('g-1', 'm-1');

      expect(moved).toBe(1);
      // The whole point of the cache: archiving is a rename, not a fetch.
      expect((axios.get as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
        callsAfterStore,
      );
      // One directory per message, so a file reconciles with its audit
      // line by id rather than by time.
      expect(listOrEmpty(path.join(archiveRoot, 'g-1'))).toEqual(['m-1']);
      const archived = archivedFiles('g-1', 'm-1');
      expect(archived).toHaveLength(1);
      // The `<attachmentId>-` prefix is a cache-layout detail; the
      // archive keeps the timestamped upload name.
      expect(archived[0]).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_pic\.png$/);
      expect(archived[0]).not.toContain(A1);
    });

    it('drops the message cache entry once every file is archived', async () => {
      const cache = cacheWith();
      await cache.store('g-1', 'm-1', [attachment(A1, 'pic.png'), attachment(A2, 'n.txt')]);

      expect(await cache.archiveCached('g-1', 'm-1')).toBe(2);
      expect(fs.existsSync(messageDir('g-1', 'm-1'))).toBe(false);
    });

    it('reports 0 for a message it never cached, so the caller falls back to the network', async () => {
      expect(await cacheWith().archiveCached('g-1', 'never-seen')).toBe(0);
    });

    it('reports 0 for an empty cache entry rather than claiming a hit', async () => {
      fs.mkdirSync(messageDir('g-1', 'm-1'), { recursive: true });
      expect(await cacheWith().archiveCached('g-1', 'm-1')).toBe(0);
    });

    it('waits for an in-flight store instead of archiving a prefix of it', async () => {
      // The scenario the whole feature exists for: the delete lands
      // while the download is still running. Reading the directory early
      // archives file one, reports a hit, and the caller then skips the
      // network fallback — losing the rest silently.
      const release: (() => void)[] = [];
      setAxiosGet(
        async () =>
          new Promise((resolve) => {
            release.push(() => {
              resolve({ data: Readable.from(['bytes']) });
            });
          }),
      );
      const cache = cacheWith();

      const storing = cache.store('g-1', 'm-1', [
        attachment(A1, 'one.png'),
        attachment(A2, 'two.png'),
      ]);
      const archiving = cache.archiveCached('g-1', 'm-1');
      // Both downloads are open and neither has written a byte, which is
      // exactly the window a delete can land in.
      await vi.waitFor(() => {
        expect(release).toHaveLength(2);
      });
      release.forEach((fn) => {
        fn();
      });
      await storing;

      expect(await archiving).toBe(2);
      expect(archivedFiles('g-1', 'm-1')).toHaveLength(2);
    });

    it('never archives a file that is still being written', async () => {
      // A `.part` sibling is a download in progress; publishing it would
      // put a truncated file in the archive under a name that reads as
      // complete.
      const dir = messageDir('g-1', 'm-1');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${A1}-half.png.part`), 'half');

      expect(await cacheWith().archiveCached('g-1', 'm-1')).toBe(0);
      expect(listOrEmpty(path.join(archiveRoot, 'g-1'))).toEqual([]);
    });

    it('keeps two messages sharing an upload name in separate message directories', async () => {
      const cache = cacheWith();
      await cache.store('g-1', 'm-1', [attachment(A1, 'same.png')]);
      await cache.store('g-1', 'm-2', [attachment(A2, 'same.png')]);

      expect(await cache.archiveCached('g-1', 'm-1')).toBe(1);
      expect(await cache.archiveCached('g-1', 'm-2')).toBe(1);

      expect(archivedFiles('g-1', 'm-1')).toHaveLength(1);
      expect(archivedFiles('g-1', 'm-2')).toHaveLength(1);
    });

    it('archives two same-named files of one message without losing either', async () => {
      // Within one message the name and (to the second) the timestamp
      // collide by construction. `publishFile`'s ordinal fallback is
      // pinned directly in attachment-io.test.ts; this guards the
      // cache's use of it.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const cache = cacheWith();
        await cache.store('g-1', 'm-1', [attachment(A1, 'same.png'), attachment(A2, 'same.png')]);

        expect(await cache.archiveCached('g-1', 'm-1')).toBe(2);

        const archived = archivedFiles('g-1', 'm-1').sort();
        expect(archived).toHaveLength(2);
        expect(archived.filter((n) => n.endsWith('_same-2.png'))).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('preserves an upload name that itself contains a hyphen', async () => {
      const cache = cacheWith();
      await cache.store('g-1', 'm-1', [attachment(A1, 'my-holiday-photo.png')]);

      await cache.archiveCached('g-1', 'm-1');

      expect(archivedFiles('g-1', 'm-1')[0]).toMatch(/my-holiday-photo\.png$/);
    });

    it('keeps the cache entry when one file could not be moved out', async () => {
      const logger = fakeLogger();
      const cache = makeCache({ logger });
      await cache.store('g-1', 'm-1', [attachment(A1, 'one.png'), attachment(A2, 'two.png')]);
      vi.spyOn(fs.promises, 'link').mockRejectedValueOnce(
        Object.assign(new Error('permission denied'), { code: 'EPERM' }),
      );

      // Deleting the directory here would destroy bytes that never
      // reached the archive; leaving it lets the TTL sweep collect them
      // and a later retry still find them.
      expect(await cache.archiveCached('g-1', 'm-1')).toBe(1);
      expect(fs.existsSync(messageDir('g-1', 'm-1'))).toBe(true);
      expect(warnCalls(logger).length).toBe(1);
      vi.restoreAllMocks();
    });

    it('reports an unreadable cache entry as a warn, not as a silent miss', async () => {
      const logger = fakeLogger();
      vi.spyOn(fs.promises, 'readdir').mockRejectedValueOnce(
        Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      );

      const moved = await makeCache({ logger }).archiveCached('g-1', 'm-1');

      // 0 so the caller still tries the network — but logged, because an
      // unreadable cache is a fault and a miss is not.
      expect(moved).toBe(0);
      expect(warnCalls(logger).length).toBe(1);
      vi.restoreAllMocks();
    });
  });

  describe('free-space floor', () => {
    const FLOOR_BYTES = FLOOR_MB * MB;

    const axiosCalls = (): number =>
      (axios.get as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    it('skips the download entirely while the volume is below the floor', async () => {
      const logger = fakeLogger();
      const cache = makeCache({ logger, statfs: volumeWith(FLOOR_BYTES - BLOCK_SIZE) });

      await cache.store('g-1', 'm-1', [attachment(A1, 'pic.png'), attachment(A2, 'n.txt')]);

      // Nothing fetched and nothing on disk: a volume this close to full
      // must gain no bytes at all from caching.
      expect(axiosCalls()).toBe(0);
      expect(fs.existsSync(messageDir('g-1', 'm-1'))).toBe(false);
    });

    it('caches while the volume is above the floor', async () => {
      const cache = makeCache({ statfs: volumeWith(FLOOR_BYTES + BLOCK_SIZE) });

      await cache.store('g-1', 'm-1', [attachment(A1, 'pic.png')]);

      expect(listOrEmpty(messageDir('g-1', 'm-1'))).toEqual([`${A1}-pic.png`]);
    });

    it('caches at exactly the floor and stops one block under it', async () => {
      // The comparison is `available < floor`. Pinning both sides of the
      // edge is what makes a `<` -> `<=` flip fail here.
      await makeCache({ statfs: volumeWith(FLOOR_BYTES) }).store('g-1', 'at', [
        attachment(A1, 'pic.png'),
      ]);
      await makeCache({ statfs: volumeWith(FLOOR_BYTES - BLOCK_SIZE) }).store('g-1', 'under', [
        attachment(A1, 'pic.png'),
      ]);

      expect(listOrEmpty(messageDir('g-1', 'at'))).toEqual([`${A1}-pic.png`]);
      expect(fs.existsSync(messageDir('g-1', 'under'))).toBe(false);
    });

    it('warns once for the pause, not once per attachment or per message', async () => {
      const logger = fakeLogger();
      const cache = makeCache({ logger, statfs: volumeWith(0) });

      await cache.store('g-1', 'm-1', [
        attachment(A1, 'a.png'),
        attachment(A2, 'b.png'),
        attachment('1300000000000000003', 'c.png'),
      ]);
      await cache.store('g-1', 'm-2', [attachment(A1, 'd.png')]);

      // A full volume affects every message; one line per skipped
      // attachment would bury the line the operator has to read.
      expect(warnCalls(logger)).toHaveLength(1);
      expect(warnCalls(logger)[0]?.[0]).toMatchObject({
        availableBytes: 0,
        minFreeBytes: FLOOR_BYTES,
      });
    });

    it('logs the resume once when space comes back, and pauses again only on the next crossing', async () => {
      const logger = fakeLogger();
      let free = 0;
      const cache = makeCache({ logger, statfs: volume(() => free) });

      await cache.store('g-1', 'm-1', [attachment(A1, 'a.png')]);
      free = 10 * FLOOR_BYTES;
      await cache.store('g-1', 'm-2', [attachment(A1, 'b.png')]);
      await cache.store('g-1', 'm-3', [attachment(A1, 'c.png')]);
      free = 0;
      await cache.store('g-1', 'm-4', [attachment(A1, 'd.png')]);
      await cache.store('g-1', 'm-5', [attachment(A1, 'e.png')]);

      expect(warnCalls(logger)).toHaveLength(2);
      expect(infoCalls(logger)).toHaveLength(1);
      expect(listOrEmpty(messageDir('g-1', 'm-2'))).toHaveLength(1);
      expect(fs.existsSync(messageDir('g-1', 'm-4'))).toBe(false);
    });

    it('keeps caching when the volume cannot be inspected, and says so once', async () => {
      const logger = fakeLogger();
      const cache = makeCache({
        logger,
        statfs: () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })),
      });

      await cache.store('g-1', 'm-1', [attachment(A1, 'a.png')]);
      await cache.store('g-1', 'm-2', [attachment(A2, 'b.png')]);

      // Fail-open: a probe that did not answer is not evidence the disk
      // is full, and refusing to cache on it loses attachments for sure.
      expect(listOrEmpty(messageDir('g-1', 'm-1'))).toHaveLength(1);
      expect(listOrEmpty(messageDir('g-1', 'm-2'))).toHaveLength(1);
      expect(warnCalls(logger)).toHaveLength(1);
    });

    it('announces once when the volume becomes readable again', async () => {
      // The operator's only signal that the floor went from unenforced
      // back to enforced. Without it, a probe outage reads as permanent.
      const logger = fakeLogger();
      let broken = true;
      const cache = makeCache({
        logger,
        statfs: () =>
          broken
            ? Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))
            : volumeWith(10 * FLOOR_BYTES)(),
      });

      await cache.store('g-1', 'm-1', [attachment(A1, 'a.png')]);
      broken = false;
      await cache.store('g-1', 'm-2', [attachment(A2, 'b.png')]);
      await cache.store('g-1', 'm-3', [attachment(A1, 'c.png')]);

      expect(warnCalls(logger)).toHaveLength(1);
      expect(infoCalls(logger)).toHaveLength(1);
    });

    it('fails open on a probe that rejects with something other than an Error', async () => {
      // The probe is an injected seam; reading `.code` off a rejected
      // string would throw from inside the handler meant to absorb it.
      const logger = fakeLogger();
      // The cast is the point: a real seam can reject with anything, and
      // the type says otherwise.
      const cache = makeCache({ logger, statfs: () => Promise.reject('nope' as unknown as Error) });

      await expect(cache.store('g-1', 'm-1', [attachment(A1, 'a.png')])).resolves.toBeUndefined();

      expect(listOrEmpty(messageDir('g-1', 'm-1'))).toHaveLength(1);
      expect(warnCalls(logger)).toHaveLength(1);
      expect(warnCalls(logger)[0]?.[0]).toMatchObject({ err: expect.any(Error) as Error });
    });

    it('probes the nearest existing ancestor before the cache root exists', async () => {
      const logger = fakeLogger();
      const probed: string[] = [];
      const cache = makeCache({
        logger,
        statfs: (target: string) => {
          probed.push(target);
          // A fresh install: the root has never been written to. Its
          // parent is on the same volume, so the floor is knowable.
          if (target === path.resolve(cacheRoot)) {
            return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
          }
          return volumeWith(10 * FLOOR_BYTES)();
        },
      });

      await cache.store('g-1', 'm-1', [attachment(A1, 'a.png')]);

      expect(probed).toEqual([path.resolve(cacheRoot), path.resolve(root)]);
      expect(listOrEmpty(messageDir('g-1', 'm-1'))).toHaveLength(1);
      // Nothing was unverifiable, so nothing is worth a line.
      expect(warnCalls(logger)).toHaveLength(0);
    });

    it('gives up at the filesystem root rather than walking forever', async () => {
      // Terminates on `parent === candidate`. Without that guard an
      // every-path-ENOENT probe spins instead of failing open.
      const logger = fakeLogger();
      const cache = makeCache({
        logger,
        statfs: () => Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })),
      });

      await cache.store('g-1', 'm-1', [attachment(A1, 'a.png')]);

      expect(listOrEmpty(messageDir('g-1', 'm-1'))).toHaveLength(1);
      expect(warnCalls(logger)).toHaveLength(1);
    });

    it('warns once for concurrent stores that all find the volume full', async () => {
      // `messageCreate` is fire-and-forget, so probes overlap. The
      // transition has to be decided once across the whole burst, not
      // once per caller that observes the same reading.
      const logger = fakeLogger();
      const cache = makeCache({ logger, statfs: volumeWith(0) });

      await Promise.all([
        cache.store('g-1', 'm-1', [attachment(A1, 'a.png')]),
        cache.store('g-1', 'm-2', [attachment(A2, 'b.png')]),
        cache.store('g-1', 'm-3', [attachment(A1, 'c.png')]),
      ]);

      expect(warnCalls(logger)).toHaveLength(1);
    });

    it('still archives an already-cached message once the volume drops below the floor', async () => {
      // The floor gates new cache writes only. Refusing to archive would
      // lose the attachment outright rather than defer it.
      let free = 10 * FLOOR_BYTES;
      const cache = makeCache({ statfs: volume(() => free) });
      await cache.store('g-1', 'm-1', [attachment(A1, 'pic.png')]);
      free = 0;

      expect(await cache.archiveCached('g-1', 'm-1')).toBe(1);
      expect(archivedFiles('g-1', 'm-1')).toHaveLength(1);
    });
  });

  describe('sweepExpired', () => {
    /** Backdate a cache entry so the sweep sees it as expired. */
    const ageBy = (guildId: string, messageId: string, ms: number, now: number): void => {
      const when = new Date(now - ms);
      fs.utimesSync(messageDir(guildId, messageId), when, when);
    };

    it('deletes entries past the TTL and keeps the ones inside it', async () => {
      const cache = cacheWith(1);
      const now = Date.now();
      await cache.store('g-1', 'old', [attachment(A1, 'old.png')]);
      await cache.store('g-1', 'fresh', [attachment(A2, 'fresh.png')]);
      ageBy('g-1', 'old', 2 * HOUR_MS, now);
      ageBy('g-1', 'fresh', 10 * 60 * 1000, now);

      expect(await cache.sweepExpired(now)).toBe(1);
      expect(fs.existsSync(messageDir('g-1', 'old'))).toBe(false);
      expect(fs.existsSync(messageDir('g-1', 'fresh'))).toBe(true);
    });

    it('collects the guild directory once its last entry expired', async () => {
      const cache = cacheWith(1);
      const now = Date.now();
      await cache.store('g-1', 'old', [attachment(A1, 'old.png')]);
      ageBy('g-1', 'old', 5 * HOUR_MS, now);

      await cache.sweepExpired(now);

      expect(fs.existsSync(path.join(cacheRoot, 'g-1'))).toBe(false);
    });

    it('keeps an entry sitting exactly on the TTL boundary and drops the next millisecond', async () => {
      // The comparison is `mtimeMs >= cutoff`. Reading the stored mtime
      // back rather than assuming the value passed to `utimes` survived
      // makes "exactly on the boundary" exact, so a `>=` -> `>` flip
      // fails here instead of passing on filesystem rounding.
      const cache = cacheWith(1);
      await cache.store('g-1', 'edge', [attachment(A1, 'edge.png')]);
      const mtimeMs = fs.statSync(messageDir('g-1', 'edge')).mtimeMs;

      expect(await cache.sweepExpired(mtimeMs + HOUR_MS)).toBe(0);
      expect(fs.existsSync(messageDir('g-1', 'edge'))).toBe(true);

      expect(await cache.sweepExpired(mtimeMs + HOUR_MS + 1)).toBe(1);
      expect(fs.existsSync(messageDir('g-1', 'edge'))).toBe(false);
    });

    it('still sweeps while the volume is below the free-space floor', async () => {
      // The sweep is how a paused cache recovers. Gating it on free
      // space would stop reclaiming disk exactly when the disk is full.
      let free = 10 * FLOOR_MB * MB;
      const cache = makeCache({ ttlHours: 1, statfs: volume(() => free) });
      const now = Date.now();
      await cache.store('g-1', 'old', [attachment(A1, 'old.png')]);
      ageBy('g-1', 'old', 5 * HOUR_MS, now);
      free = 0;

      expect(await cache.sweepExpired(now)).toBe(1);
      expect(fs.existsSync(messageDir('g-1', 'old'))).toBe(false);
    });

    it('reports nothing swept when the cache tree does not exist yet', async () => {
      expect(await cacheWith().sweepExpired(Date.now())).toBe(0);
    });

    it('warns and keeps going when one entry cannot be inspected', async () => {
      const logger = fakeLogger();
      const cache = makeCache({ ttlHours: 1, logger });
      const now = Date.now();
      await cache.store('g-1', 'bad', [attachment(A1, 'a.png')]);
      await cache.store('g-1', 'old', [attachment(A2, 'b.png')]);
      ageBy('g-1', 'bad', 5 * HOUR_MS, now);
      ageBy('g-1', 'old', 5 * HOUR_MS, now);
      vi.spyOn(fs.promises, 'stat').mockRejectedValueOnce(
        Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      );

      expect(await cache.sweepExpired(now)).toBe(1);
      expect(warnCalls(logger).length).toBe(1);
      vi.restoreAllMocks();
    });
  });
});
