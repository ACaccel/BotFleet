import { afterEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';
import { existsSync, readdirSync, readFileSync, rmSync, promises as fsPromises } from 'fs';
import { Readable } from 'node:stream';
import { resolve } from 'path';

import { archiveDeletedAttachment, archiveDeletedAttachments } from '../../../../src/infra/discord';
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

const attachmentNamed = (name: string) =>
  ({ name, url: `https://example.invalid/${name}` }) as never;

/** Attachment carrying the `media.discordapp.net` mirror the fallback retries. */
const attachmentWithProxy = (name: string) =>
  ({
    name,
    url: `https://cdn.invalid/${name}`,
    proxyURL: `https://media.invalid/${name}`,
  }) as never;

/** An axios-shaped rejection: the helper reads `response.status` off it. */
const httpError = (status: number): Error =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });

/** URLs `axios.get` was called with, in order. */
const requestedUrls = (): string[] =>
  (axios.get as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as string);

const callCount = (fn: unknown): number => (fn as ReturnType<typeof vi.fn>).mock.calls.length;

/** Guild directory the helper writes under; removed wholesale after each case. */
const GUILD_DIR = resolve('data/deleted_attachments/g-1');

/** Message directory the helper writes into for guild `g-1`, message `m-1`. */
const ARCHIVE_DIR = resolve(GUILD_DIR, 'm-1');

const setAxiosGet = (impl: (...args: unknown[]) => unknown): void => {
  (axios.get as unknown as ReturnType<typeof vi.fn>) = vi.fn(impl);
};

/** Names of the files the helper wrote for guild `g-1`, if any. */
const listArchiveFiles = (): string[] => (existsSync(ARCHIVE_DIR) ? readdirSync(ARCHIVE_DIR) : []);

const findOnlyFileName = (): string => {
  const files = listArchiveFiles();
  if (files.length !== 1) {
    throw new Error(`expected exactly one archived file, found ${files.length}`);
  }
  return files[0] as string;
};

describe('archiveDeletedAttachment', () => {
  // The helper mkdir's ./data/deleted_attachments/<guildId>/ before the
  // download, so the real directory is created as a side effect of exercising
  // the function. Remove it after each case so a unit run leaves no artifact
  // in the working tree (`data/` is gitignored but should not be polluted).
  // `force` tolerates an already-absent directory.
  afterEach(() => {
    rmSync(GUILD_DIR, { recursive: true, force: true });
  });

  it('logs warn and does not retry when the fetch fails with no proxy URL to fall back to', async () => {
    const logger = fakeLogger();
    setAxiosGet(async () => {
      throw new Error('upstream 404');
    });
    await archiveDeletedAttachment(logger, 'g-1', 'm-1', attachmentNamed('pic.png'));
    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(requestedUrls()).toHaveLength(1);
  });

  it('does not retry a proxy URL identical to the one that just failed', async () => {
    const logger = fakeLogger();
    setAxiosGet(async () => {
      throw httpError(404);
    });
    const same = 'https://cdn.invalid/same.png';

    await archiveDeletedAttachment(logger, 'g-1', 'm-1', {
      name: 'same.png',
      url: same,
      proxyURL: same,
    } as never);

    expect(requestedUrls()).toEqual([same]);
    expect(callCount(logger.warn)).toBe(1);
  });

  it('does not retry an empty proxy URL', async () => {
    const logger = fakeLogger();
    setAxiosGet(async () => {
      throw httpError(404);
    });

    await archiveDeletedAttachment(logger, 'g-1', 'm-1', {
      name: 'blank.png',
      url: 'https://cdn.invalid/blank.png',
      proxyURL: '',
    } as never);

    expect(requestedUrls()).toHaveLength(1);
  });

  it('logs error and never reaches the network when the archive directory cannot be created', async () => {
    const logger = fakeLogger();
    setAxiosGet(async () => ({ data: Readable.from(['payload']) }));
    vi.spyOn(fsPromises, 'mkdir').mockRejectedValueOnce(
      Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    );

    await archiveDeletedAttachment(logger, 'g-1', 'm-1', attachmentNamed('pic.png'));

    expect(callCount(logger.error)).toBe(1);
    expect(requestedUrls()).toEqual([]);
    vi.restoreAllMocks();
  });

  it('requests the download with a wall-clock deadline and a size ceiling', async () => {
    const logger = fakeLogger();
    setAxiosGet(async () => ({ data: Readable.from(['payload']) }));

    await archiveDeletedAttachment(logger, 'g-1', 'm-1', attachmentNamed('bounded.bin'));

    const [, options] = (axios.get as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { signal?: AbortSignal; maxContentLength?: number },
    ];
    // A true deadline, not axios's `timeout` (socket inactivity, which a
    // slow trickle resets forever): without it a stalled CDN response
    // hangs the transfer promise and leaks the open write handle.
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.maxContentLength).toBeGreaterThan(0);
  });

  it('writes the streamed body to disk', async () => {
    const logger = fakeLogger();
    setAxiosGet(async () => ({ data: Readable.from(['hello ', 'world']) }));

    await archiveDeletedAttachment(logger, 'g-1', 'm-1', attachmentNamed('note.txt'));

    const written = readFileSync(resolve(ARCHIVE_DIR, findOnlyFileName()), 'utf8');
    expect(written).toBe('hello world');
  });

  it('names the file <timestamp>_<name> inside a directory named for the message id', async () => {
    const logger = fakeLogger();
    setAxiosGet(async () => ({ data: Readable.from(['payload']) }));

    await archiveDeletedAttachment(logger, 'g-1', 'm-1', attachmentNamed('layout.png'));

    expect(readdirSync(GUILD_DIR)).toEqual(['m-1']);
    expect(findOnlyFileName()).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_layout\.png$/);
  });

  it('keeps a hostile message id inside the guild directory', async () => {
    const logger = fakeLogger();
    setAxiosGet(async () => ({ data: Readable.from(['payload']) }));

    await archiveDeletedAttachment(logger, 'g-1', '../../escape', attachmentNamed('x.png'));

    expect(readdirSync(GUILD_DIR)).toEqual(['escape']);
  });

  it('resolves (and removes the partial file) when the source stream errors mid-transfer', async () => {
    const logger = fakeLogger();
    setAxiosGet(async () => ({
      data: new Readable({
        read(): void {
          this.push('partial');
          this.destroy(new Error('CDN connection reset'));
        },
      }),
    }));

    // The old `pipe` + `finish` listener never observed a source error, so
    // this promise stayed pending forever. It must settle.
    await archiveDeletedAttachment(logger, 'g-1', 'm-1', attachmentNamed('truncated.bin'));

    expect((logger.error as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(listArchiveFiles()).toEqual([]);
  });
});

/**
 * Discord purges an attachment's CDN object nearly synchronously with
 * the message deletion, so `attachment.url` 404s even while its
 * signature is still valid. `attachment.proxyURL` points at
 * `media.discordapp.net`, whose cache often still holds recently
 * displayed media — one retry there is the difference between an
 * archived file and nothing.
 */
describe('archiveDeletedAttachment proxyURL fallback', () => {
  afterEach(() => {
    rmSync(GUILD_DIR, { recursive: true, force: true });
  });

  it('retries the proxy URL and archives the body when the primary URL is purged', async () => {
    const logger = fakeLogger();
    setAxiosGet(async (url: unknown) => {
      if (String(url).startsWith('https://cdn.invalid/')) throw httpError(404);
      return { data: Readable.from(['recovered']) };
    });

    await archiveDeletedAttachment(logger, 'g-1', 'm-1', attachmentWithProxy('pic.png'));

    expect(requestedUrls()).toEqual([
      'https://cdn.invalid/pic.png',
      'https://media.invalid/pic.png',
    ]);
    expect(readFileSync(resolve(ARCHIVE_DIR, findOnlyFileName()), 'utf8')).toBe('recovered');
  });

  it('logs the expected purge race at info, not warn, when the fallback recovers the file', async () => {
    const logger = fakeLogger();
    setAxiosGet(async (url: unknown) => {
      if (String(url).startsWith('https://cdn.invalid/')) throw httpError(404);
      return { data: Readable.from(['recovered']) };
    });

    await archiveDeletedAttachment(logger, 'g-1', 'm-1', attachmentWithProxy('pic.png'));

    // A 404 at delete time is the documented race, not an incident;
    // warning on it trains operators to ignore the channel.
    expect(callCount(logger.info)).toBe(1);
    expect(callCount(logger.warn)).toBe(0);
  });

  it('logs at info when both ends 404 — the object is simply gone', async () => {
    const logger = fakeLogger();
    setAxiosGet(async () => {
      throw httpError(404);
    });

    await archiveDeletedAttachment(logger, 'g-1', 'm-1', attachmentWithProxy('pic.png'));

    expect(requestedUrls()).toHaveLength(2);
    expect(callCount(logger.info)).toBe(1);
    expect(callCount(logger.warn)).toBe(0);
    expect(listArchiveFiles()).toEqual([]);
  });

  it('logs at warn when the fallback fails with anything other than a 404', async () => {
    const logger = fakeLogger();
    setAxiosGet(async (url: unknown) => {
      throw String(url).startsWith('https://cdn.invalid/') ? httpError(404) : httpError(503);
    });

    await archiveDeletedAttachment(logger, 'g-1', 'm-1', attachmentWithProxy('pic.png'));

    // A proxy that is failing rather than empty is a real transport
    // problem and must stay visible.
    expect(callCount(logger.warn)).toBe(1);
    expect(callCount(logger.info)).toBe(0);
  });

  it('logs at warn when a non-404 primary failure is rescued by the fallback', async () => {
    const logger = fakeLogger();
    setAxiosGet(async (url: unknown) => {
      if (String(url).startsWith('https://cdn.invalid/')) throw new Error('ECONNRESET');
      return { data: Readable.from(['recovered']) };
    });

    await archiveDeletedAttachment(logger, 'g-1', 'm-1', attachmentWithProxy('pic.png'));

    // The file was saved, but a reset connection to the primary CDN is a
    // real transport fault — downgrading it to info would hide it.
    expect(readFileSync(resolve(ARCHIVE_DIR, findOnlyFileName()), 'utf8')).toBe('recovered');
    expect(callCount(logger.warn)).toBe(1);
    expect(callCount(logger.info)).toBe(0);
  });

  it('logs at warn when the primary failure was never the purge race', async () => {
    const logger = fakeLogger();
    setAxiosGet(async () => {
      throw new Error('ECONNRESET');
    });

    await archiveDeletedAttachment(logger, 'g-1', 'm-1', attachmentWithProxy('pic.png'));

    expect(requestedUrls()).toHaveLength(2);
    expect(callCount(logger.warn)).toBe(1);
    expect(callCount(logger.info)).toBe(0);
  });

  it('does not retry a local write failure — a second fetch cannot fix the disk', async () => {
    const logger = fakeLogger();
    setAxiosGet(async () => ({
      data: new Readable({
        read(): void {
          this.push('partial');
          this.destroy(new Error('CDN connection reset'));
        },
      }),
    }));

    await archiveDeletedAttachment(logger, 'g-1', 'm-1', attachmentWithProxy('truncated.bin'));

    expect(requestedUrls()).toHaveLength(1);
    expect(callCount(logger.error)).toBe(1);
    expect(listArchiveFiles()).toEqual([]);
  });
});

describe('archiveDeletedAttachments', () => {
  afterEach(() => {
    rmSync(GUILD_DIR, { recursive: true, force: true });
  });

  it('bounds how many downloads run at once across a bulk delete', async () => {
    const logger = fakeLogger();
    let inFlight = 0;
    let peak = 0;
    const held: (() => void)[] = [];
    setAxiosGet(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((release) => held.push(release));
      inFlight -= 1;
      return { data: Readable.from(['x']) };
    });

    const attachments = Array.from({ length: 20 }, (_, i) => attachmentNamed(`bulk-${i}.bin`));
    const archived = archiveDeletedAttachments(logger, 'g-1', 'm-1', attachments);
    // Each download creates its directory over real I/O before the
    // request, so release one only after every slot the limiter may
    // fill is occupied; the peak then never depends on timing.
    for (let remaining = attachments.length; remaining > 0; remaining -= 1) {
      await vi.waitFor(() => expect(held.length).toBeGreaterThanOrEqual(Math.min(4, remaining)), {
        interval: 1,
      });
      held.shift()?.();
    }
    await archived;

    expect((axios.get as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(20);
    // A bulk delete of 100 messages used to open every download at once.
    expect(peak).toBeLessThanOrEqual(4);
  });
});
