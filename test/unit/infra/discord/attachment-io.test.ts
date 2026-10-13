/**
 * The attachment file-I/O primitives both archival paths share.
 *
 * These are the pieces whose failure is silent: a name that escapes its
 * directory, a name too long to write at all, a publish that overwrites
 * an earlier forensic file. Each is covered here directly rather than
 * left to whichever caller happens to reach it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'node:stream';

import {
  PARTIAL_SUFFIX,
  archiveFilePath,
  downloadToFile,
  publishFile,
  runBounded,
  sanitizeFileName,
} from '../../../../src/infra/discord/attachment-io';

vi.mock('axios');

describe('sanitizeFileName', () => {
  it('reduces a traversal attempt to its last segment', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('/absolute/path/pic.png')).toBe('pic.png');
  });

  it('treats a Windows separator as a separator too', () => {
    expect(sanitizeFileName('..\\..\\windows\\system32\\cmd.exe')).toBe('cmd.exe');
  });

  it('substitutes a placeholder for a name that reduces to nothing', () => {
    // `''`, `.` and `..` are all valid `basename` outputs that are not
    // usable file names; writing to them would target the directory.
    expect(sanitizeFileName('')).toBe('attachment');
    expect(sanitizeFileName('.')).toBe('attachment');
    expect(sanitizeFileName('..')).toBe('attachment');
    expect(sanitizeFileName('foo/..')).toBe('attachment');
  });

  it('caps an over-long name while keeping its extension', () => {
    // Uncapped, the prefixed name exceeds the 255-byte segment limit and
    // the write fails with ENAMETOOLONG — the attachment is then never
    // archived at all.
    const result = sanitizeFileName(`${'a'.repeat(500)}.png`);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(160);
    expect(result.endsWith('.png')).toBe(true);
  });

  it('caps by bytes, not characters, so multi-byte names still fit', () => {
    const result = sanitizeFileName(`${'é'.repeat(300)}.png`);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(160);
  });

  it('leaves an ordinary name untouched', () => {
    expect(sanitizeFileName('my-holiday-photo.png')).toBe('my-holiday-photo.png');
  });
});

describe('archiveFilePath', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lands at <root>/<guildId>/<messageId>/<stamp>_<name> in zero-padded local time', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Local-time constructor, so the expectation holds in any host timezone.
    vi.setSystemTime(new Date(2026, 0, 2, 3, 4, 5));

    const result = archiveFilePath('g-1', 'm-1', 'pic.png', '/tmp/archive-root');

    expect(result).toBe(
      path.join('/tmp/archive-root', 'g-1', 'm-1', '2026-01-02_03-04-05_pic.png'),
    );
  });

  it('sorts lexicographically in time order', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 9, 23, 59, 59));
    const earlier = path.basename(archiveFilePath('g-1', 'm-1', 'a.png', '/r'));
    vi.setSystemTime(new Date(2026, 9, 10, 0, 0, 0));
    const later = path.basename(archiveFilePath('g-1', 'm-1', 'a.png', '/r'));

    expect(earlier < later).toBe(true);
  });

  it('sanitises the name on the way out, not only on the way in', () => {
    const result = archiveFilePath('g-1', 'm-1', '../../escape.png', '/tmp/archive-root');
    expect(path.dirname(result)).toBe(path.join('/tmp/archive-root', 'g-1', 'm-1'));
    expect(path.basename(result).endsWith('_escape.png')).toBe(true);
  });

  it('reduces a hostile message id to a single path segment', () => {
    for (const hostile of ['../../escape', '..', '', 'a/b']) {
      const result = archiveFilePath('g-1', hostile, 'pic.png', '/tmp/archive-root');
      expect(
        path.relative(path.join('/tmp/archive-root', 'g-1'), result).split(path.sep),
      ).toHaveLength(2);
    }
  });

  it('keeps the longest allowed name, ordinal and .part suffix under 255 bytes', () => {
    const name = `${'é'.repeat(300)}.png`;
    const base = path.basename(archiveFilePath('g-1', 'm-1', name, '/r'));
    expect(Buffer.byteLength(`${base}-50${PARTIAL_SUFFIX}`)).toBeLessThanOrEqual(255);
  });
});

describe('publishFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-io-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, body: string): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, body);
    return file;
  };

  it('moves the source onto the destination and removes the source', async () => {
    const source = write('source.bin', 'payload');

    await publishFile(source, path.join(dir, 'published.bin'));

    expect(fs.readFileSync(path.join(dir, 'published.bin'), 'utf8')).toBe('payload');
    expect(fs.existsSync(source)).toBe(false);
  });

  it('takes an ordinal name rather than overwriting an occupied one', async () => {
    write('taken.bin', 'first');
    const source = write('source.bin', 'second');

    await publishFile(source, path.join(dir, 'taken.bin'));

    // Overwriting here destroys an earlier forensic file with no error
    // and no log — the exact failure the archive exists to prevent.
    expect(fs.readFileSync(path.join(dir, 'taken.bin'), 'utf8')).toBe('first');
    expect(fs.readFileSync(path.join(dir, 'taken-2.bin'), 'utf8')).toBe('second');
  });

  it('keeps climbing ordinals as each one fills up', async () => {
    write('taken.bin', 'first');
    write('taken-2.bin', 'second');

    await publishFile(write('source.bin', 'third'), path.join(dir, 'taken.bin'));

    expect(fs.readFileSync(path.join(dir, 'taken-3.bin'), 'utf8')).toBe('third');
  });

  it('raises rather than silently dropping the file when every name is taken', async () => {
    const destination = path.join(dir, 'taken.bin');
    fs.writeFileSync(destination, 'x');
    for (let n = 2; n <= 50; n += 1)
      fs.writeFileSync(path.join(dir, `taken-${String(n)}.bin`), 'x');

    await expect(publishFile(write('source.bin', 'y'), destination)).rejects.toThrow(
      /every candidate name/,
    );
  });

  it('propagates a filesystem refusal instead of reporting success', async () => {
    vi.spyOn(fs.promises, 'link').mockRejectedValue(
      Object.assign(new Error('read-only'), { code: 'EROFS' }),
    );

    await expect(
      publishFile(write('source.bin', 'y'), path.join(dir, 'published.bin')),
    ).rejects.toThrow(/read-only/);
  });

  it('falls back to an exclusive copy when the move crosses a filesystem', async () => {
    const realLink = fs.promises.link.bind(fs.promises);
    vi.spyOn(fs.promises, 'link').mockImplementation(async (from, to) => {
      if (String(to).endsWith('crossed.bin')) {
        throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
      }
      return realLink(from, to);
    });
    const source = write('source.bin', 'payload');

    await publishFile(source, path.join(dir, 'crossed.bin'));

    expect(fs.readFileSync(path.join(dir, 'crossed.bin'), 'utf8')).toBe('payload');
    expect(fs.existsSync(source)).toBe(false);
  });

  it('removes its own partial copy when a cross-filesystem copy fails', async () => {
    vi.spyOn(fs.promises, 'link').mockRejectedValue(
      Object.assign(new Error('cross-device link'), { code: 'EXDEV' }),
    );
    vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (_from, to) => {
      // A copy that dies part-way (a full disk, typically) still leaves
      // bytes behind; left there they read as a complete archive.
      fs.writeFileSync(String(to), 'half');
      throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
    });
    const destination = path.join(dir, 'published.bin');

    await expect(publishFile(write('source.bin', 'payload'), destination)).rejects.toThrow(
      /no space left/,
    );
    expect(fs.existsSync(destination)).toBe(false);
  });
});

describe('runBounded', () => {
  it('holds concurrency at the process-wide ceiling across separate calls', async () => {
    // The bound has to span calls: `messageCreate` starts one of these
    // per message without waiting, so a per-call limiter would still let
    // an upload burst open an unbounded number of sockets.
    let active = 0;
    let peak = 0;
    const worker = async (): Promise<void> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      active -= 1;
    };

    await Promise.all([
      runBounded([1, 2, 3, 4, 5, 6], worker),
      runBounded([7, 8, 9, 10, 11, 12], worker),
    ]);

    expect(peak).toBeLessThanOrEqual(4);
  });

  it('attempts every item and resolves on an empty batch', async () => {
    const seen: number[] = [];
    await runBounded([1, 2, 3], async (item) => {
      seen.push(item);
    });
    expect(seen.sort()).toEqual([1, 2, 3]);
    await expect(runBounded([], async () => undefined)).resolves.toBeUndefined();
  });

  it('releases its slot even when the worker throws, so the pool cannot wedge', async () => {
    await expect(
      runBounded([1], async () => {
        throw new Error('worker blew up');
      }),
    ).rejects.toThrow(/worker blew up/);

    // If the failed run had leaked its slot, four more failures would
    // exhaust the pool and this call would hang forever.
    await expect(runBounded([1, 2], async () => undefined)).resolves.toBeUndefined();
  });
});

describe('downloadToFile', () => {
  const STALL_MS = 30_000;
  const CEILING_MS = 10 * 60_000;

  let dir: string;
  let target: string;

  beforeEach(() => {
    // Only the deadline's own timers are faked; streams schedule their
    // internal work on `nextTick` and `setImmediate`, which stay real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-io-download-'));
    target = path.join(dir, 'file.bin');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  type GetOptions = { signal: AbortSignal };

  /**
   * A body that emits `chunks` one every `intervalMs`, then ends unless
   * `endless`. Mimics the axios adapter's abort handling: the signal
   * firing destroys the stream with the abort reason.
   */
  const trickle = (
    signal: AbortSignal,
    chunks: readonly string[],
    intervalMs: number,
    endless = false,
  ): Readable => {
    const queue = [...chunks];
    const stream = new Readable({
      read(): void {
        setTimeout(() => {
          const next = queue.shift();
          if (next !== undefined) stream.push(next);
          else if (endless) stream.push('.');
          else stream.push(null);
        }, intervalMs);
      },
    });
    signal.addEventListener('abort', () => stream.destroy(signal.reason as Error));
    return stream;
  };

  /**
   * Wait until the request has been issued. `downloadToFile` creates
   * its directory over real I/O first; advancing the fake clock before
   * the deadline exists would jump past the moment it is due to fire.
   */
  const requestIssued = async (): Promise<void> => {
    while ((axios.get as unknown as ReturnType<typeof vi.fn>).mock.calls.length === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  const serveBody = (body: (signal: AbortSignal) => Readable): void => {
    (axios.get as unknown as ReturnType<typeof vi.fn>) = vi.fn(
      async (_url: string, options: GetOptions) => ({ data: body(options.signal) }),
    );
  };

  it('keeps a slow but progressing transfer alive past the stall window', async () => {
    // Four chunks 20 s apart run 80 s, well over the old fixed 30 s
    // budget that abandoned an ordinary image on a shared link.
    serveBody((signal) => trickle(signal, ['a', 'b', 'c', 'd'], 20_000));

    const result = downloadToFile('https://cdn.invalid/slow.bin', target);
    await requestIssued();
    await vi.advanceTimersByTimeAsync(100_000);

    await expect(result).resolves.toBeUndefined();
    expect(fs.readFileSync(target, 'utf8')).toBe('abcd');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('abandons a body that stops sending, naming the stall, and removes the partial file', async () => {
    // One chunk, then silence: a socket the CDN accepted and forgot.
    serveBody((signal) => {
      const stream = new Readable({ read(): void {} });
      stream.push('a');
      signal.addEventListener('abort', () => stream.destroy(signal.reason as Error));
      return stream;
    });

    const result = downloadToFile('https://cdn.invalid/stalled.bin', target);
    await requestIssued();
    await vi.advanceTimersByTimeAsync(STALL_MS + 1);

    const failure = await result;
    expect(failure?.stage).toBe('write');
    expect(failure?.error.message).toMatch(/stalled/);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(`${target}${PARTIAL_SUFFIX}`)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('abandons an endless trickle at the ceiling even though bytes keep arriving', async () => {
    serveBody((signal) => trickle(signal, [], 20_000, true));

    const result = downloadToFile('https://cdn.invalid/trickle.bin', target);
    await requestIssued();
    await vi.advanceTimersByTimeAsync(CEILING_MS + 1);

    const failure = await result;
    expect(failure?.stage).toBe('write');
    expect(failure?.error.message).toMatch(/ceiling/);
    expect(fs.existsSync(`${target}${PARTIAL_SUFFIX}`)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('applies the stall window to the wait for headers too', async () => {
    (axios.get as unknown as ReturnType<typeof vi.fn>) = vi.fn(
      (_url: string, options: GetOptions) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason));
        }),
    );

    const result = downloadToFile('https://cdn.invalid/no-headers.bin', target);
    await requestIssued();
    await vi.advanceTimersByTimeAsync(STALL_MS + 1);

    const failure = await result;
    expect(failure?.stage).toBe('fetch');
    expect(failure?.error.message).toMatch(/stalled/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a failure of the request itself untouched when no deadline fired', async () => {
    (axios.get as unknown as ReturnType<typeof vi.fn>) = vi.fn(async () => {
      throw Object.assign(new Error('gone'), { response: { status: 404 } });
    });

    const failure = await downloadToFile('https://cdn.invalid/gone.bin', target);

    expect(failure?.stage).toBe('fetch');
    expect(failure?.status).toBe(404);
    expect(failure?.error.message).toBe('gone');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('PARTIAL_SUFFIX', () => {
  it('is the marker readers use to skip an in-progress download', () => {
    expect(`file.png${PARTIAL_SUFFIX}`.endsWith(PARTIAL_SUFFIX)).toBe(true);
  });
});
