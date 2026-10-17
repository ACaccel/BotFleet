/**
 * Unit tests for {@link GalleryReaderService} and its building blocks: the
 * byte-bounded image LRU, the two-priority download limiter, metadata
 * caching with shared in-flight reads, prefetching around the page shown,
 * the stale-URL refresh, and per-message serialization.
 */
import { describe, expect, it, vi } from 'vitest';

import { DownloadLimiter } from '../../../../src/application/gallery-reader/download-limiter';
import { GalleryImageCache } from '../../../../src/application/gallery-reader/image-cache';
import {
  GalleryReaderService,
  type GalleryStagingPort,
} from '../../../../src/application/gallery-reader/service';
import { invalidResponseError } from '../../../../src/infra/link-preview';
import type {
  Gallery,
  GalleryImage,
  GalleryImageOutcome,
  GallerySource,
} from '../../../../src/infra/link-preview';
import { err, ok } from '../../../../src/core/result';

const image = (size: number, tag = 0): GalleryImage => ({
  data: Buffer.alloc(size, tag),
  extension: 'webp',
});

const gallery = (pages: number, version = 'v1'): Gallery => ({
  source: 'nhentai',
  id: '1',
  url: 'https://nhentai.net/g/1/',
  title: 'Title',
  tags: [],
  pages: Array.from({ length: pages }, (_, index) => ({
    urls: [`https://img.example.net/${version}/${index + 1}.webp`],
  })),
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

describe('GalleryImageCache', () => {
  it('evicts least recently used entries to stay within the byte budget', () => {
    const cache = new GalleryImageCache(10, 1000, () => 0);
    cache.set('a', image(4));
    cache.set('b', image(4));
    cache.get('a');
    cache.set('c', image(4));
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
    expect(cache.totalBytes).toBe(8);
  });

  it('expires entries, skips oversize images and drops a gallery by prefix', () => {
    let now = 0;
    const cache = new GalleryImageCache(10, 100, () => now);
    cache.set('g:1:0', image(2));
    cache.set('g:2:0', image(2));
    cache.set('big', image(11));
    expect(cache.has('big')).toBe(false);
    cache.deletePrefix('g:1:');
    expect(cache.has('g:1:0')).toBe(false);
    now = 100;
    expect(cache.get('g:2:0')).toBeUndefined();
    expect(cache.totalBytes).toBe(0);
  });
});

describe('DownloadLimiter', () => {
  it('starts waiting foreground work before queued prefetches, and promotes on demand', async () => {
    const limiter = new DownloadLimiter(1, 10);
    const order: string[] = [];
    let release: () => void = () => undefined;
    const blocker = limiter.run(
      'block',
      'foreground',
      () => new Promise<void>((r) => (release = r)),
    );
    const task = (name: string) => async () => {
      order.push(name);
    };
    void limiter.run('p1', 'prefetch', task('p1'));
    void limiter.run('p2', 'prefetch', task('p2'));
    void limiter.run('f1', 'foreground', task('f1'));
    limiter.promote('p2');
    release();
    await blocker;
    await flush();
    expect(order).toEqual(['f1', 'p2', 'p1']);
  });

  it('declines prefetches once its queue is full', async () => {
    const limiter = new DownloadLimiter(1, 1);
    void limiter.run('block', 'foreground', () => new Promise(() => undefined));
    void limiter.run('p1', 'prefetch', async () => 'p1');
    expect(limiter.acceptsPrefetch()).toBe(false);
    expect(await limiter.run('p2', 'prefetch', async () => 'p2')).toBeUndefined();
  });
});

const sourceReturning = (
  ...galleries: Array<Gallery | null>
): GallerySource & { fetch: ReturnType<typeof vi.fn> } => {
  const queue = [...galleries];
  return {
    name: 'nhentai',
    parse: () => undefined,
    fetch: vi.fn(async () => ok(queue.length > 1 ? (queue.shift() ?? null) : (queue[0] ?? null))),
  };
};

const reader = (
  source: GallerySource,
  getImage: (url: string) => Promise<GalleryImageOutcome>,
  prefetchPages = 2,
) =>
  new GalleryReaderService({
    sources: [source],
    http: { getImage: vi.fn(getImage) },
    prefetchPages,
    cacheMaxBytes: 1024,
    maxImageBytes: 64,
    imageTimeoutMs: 1000,
    metadataTimeoutMs: 1000,
  });

const okImage = async (_url: string): Promise<GalleryImageOutcome> => ({
  ok: true,
  image: image(8),
});

describe('GalleryReaderService', () => {
  it('clamps the page, then prefetches the next pages and the previous one', async () => {
    const source = sourceReturning(gallery(10));
    const getImage = vi.fn(okImage);
    const service = reader(source, getImage);

    const outcome = await service.loadPage('nhentai', '1', 5);
    expect(outcome.status === 'ok' && outcome.page).toBe(5);
    await flush();
    expect(getImage.mock.calls.map(([url]) => url)).toEqual([
      'https://img.example.net/v1/5.webp',
      'https://img.example.net/v1/6.webp',
      'https://img.example.net/v1/7.webp',
      'https://img.example.net/v1/4.webp',
    ]);

    getImage.mockClear();
    const next = await service.loadPage('nhentai', '1', 99);
    expect(next.status === 'ok' && next.page).toBe(10);
    await service.loadPage('nhentai', '1', 6);
    expect(getImage).not.toHaveBeenCalledWith('https://img.example.net/v1/6.webp');
    expect(source.fetch).toHaveBeenCalledTimes(1);
  });

  it('serves a remembered gallery without reading the source', async () => {
    const source = sourceReturning(gallery(1));
    const service = reader(source, okImage, 0);
    service.remember(gallery(1));
    expect((await service.loadPage('nhentai', '1', 1)).status).toBe('ok');
    expect(source.fetch).not.toHaveBeenCalled();
  });

  it('shares one metadata read and one download between concurrent requests', async () => {
    const source = sourceReturning(gallery(1));
    const getImage = vi.fn(okImage);
    const service = reader(source, getImage, 0);
    const [a, b] = await Promise.all([
      service.loadPage('nhentai', '1', 1),
      service.loadPage('nhentai', '1', 1),
    ]);
    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');
    expect(source.fetch).toHaveBeenCalledTimes(1);
    expect(getImage).toHaveBeenCalledTimes(1);
  });

  it('refetches the gallery once when every page URL is stale', async () => {
    const source = sourceReturning(gallery(2, 'old'), gallery(2, 'new'));
    const service = reader(
      source,
      async (url) =>
        url.includes('/old/') ? { ok: false, reason: 'gone' } : { ok: true, image: image(8) },
      0,
    );
    const outcome = await service.loadPage('nhentai', '1', 1);
    expect(outcome.status).toBe('ok');
    expect(source.fetch).toHaveBeenCalledTimes(2);
  });

  it('tries mirrors in order and reports unavailable when all fail', async () => {
    const twoMirrors: Gallery = {
      ...gallery(1),
      pages: [{ urls: ['https://a.example.net/1.webp', 'https://b.example.net/1.webp'] }],
    };
    const getImage = vi.fn(
      async (url: string): Promise<GalleryImageOutcome> =>
        url.startsWith('https://b.')
          ? { ok: true, image: image(8) }
          : { ok: false, reason: 'failed' },
    );
    expect(
      (await reader(sourceReturning(twoMirrors), getImage, 0).loadPage('nhentai', '1', 1)).status,
    ).toBe('ok');
    expect(getImage).toHaveBeenCalledTimes(2);

    const failing = reader(
      sourceReturning(gallery(1)),
      async () => ({ ok: false, reason: 'failed' }),
      0,
    );
    expect(await failing.loadPage('nhentai', '1', 1)).toEqual({ status: 'unavailable' });
  });

  it('maps missing galleries, failed reads and unknown sources', async () => {
    expect(await reader(sourceReturning(null), okImage).loadPage('nhentai', '1', 1)).toEqual({
      status: 'not_found',
    });
    const broken: GallerySource = {
      name: 'nhentai',
      parse: () => undefined,
      fetch: async () => err(invalidResponseError('nhentai')),
    };
    expect(await reader(broken, okImage).loadPage('nhentai', '1', 1)).toEqual({
      status: 'unavailable',
    });
    const service = reader(sourceReturning(gallery(1)), okImage);
    expect(service.supports('wnacg')).toBe(false);
    expect(await service.loadPage('wnacg', '1', 1)).toEqual({ status: 'not_found' });
  });

  it('runs tasks for one message strictly one after another, even after a failure', async () => {
    const service = reader(sourceReturning(gallery(1)), okImage);
    const order: string[] = [];
    let release: () => void = () => undefined;
    const first = service.serialize('m', async () => {
      await new Promise<void>((resolve) => (release = resolve));
      order.push('first');
      throw new Error('boom');
    });
    const second = service.serialize('m', async () => {
      order.push('second');
      return 2;
    });
    const other = service.serialize('other', async () => {
      order.push('other');
    });
    await other;
    expect(service.isBusy('m')).toBe(true);
    release();
    await expect(first).rejects.toThrow('boom');
    expect(await second).toBe(2);
    expect(order).toEqual(['other', 'first', 'second']);
    await flush();
    expect(service.isBusy('m')).toBe(false);
  });
});

describe('GalleryReaderService staging', () => {
  const stagingFake = (expiresIn = 24 * 60 * 60 * 1000) => {
    const calls: string[][] = [];
    return {
      calls,
      stage: vi.fn(async (files: ReadonlyArray<{ name: string }>) => {
        calls.push(files.map((file) => file.name));
        return files.map((file) => ({
          url: `https://cdn.discordapp.com/${file.name}`,
          expiresAt: expiresIn,
        }));
      }),
    };
  };
  const stagedReader = (staging: GalleryStagingPort, getImage = okImage) =>
    new GalleryReaderService({
      sources: [sourceReturning(gallery(10))],
      http: { getImage: vi.fn(getImage) },
      prefetchPages: 2,
      cacheMaxBytes: 1024,
      maxImageBytes: 64,
      imageTimeoutMs: 1000,
      metadataTimeoutMs: 1000,
      staging,
      now: () => 0,
    });

  it('uploads a doubled window nearest page first, then serves pages by URL', async () => {
    const staging = stagingFake();
    const service = stagedReader(staging);

    const first = await service.loadPage('nhentai', '1', 1);
    expect(first.status === 'ok' && first.media.kind).toBe('file');
    await flush();
    expect(staging.calls).toEqual([
      ['nhentai-1-2.webp'],
      ['nhentai-1-3.webp', 'nhentai-1-4.webp'],
      ['nhentai-1-5.webp', 'nhentai-1-1.webp'],
    ]);

    const second = await service.loadPage('nhentai', '1', 2);
    expect(second.status === 'ok' && second.media).toEqual({
      kind: 'url',
      url: 'https://cdn.discordapp.com/nhentai-1-2.webp',
    });
    await flush();
    expect(staging.calls).toHaveLength(3);

    await service.loadPage('nhentai', '1', 4);
    await flush();
    expect(staging.calls.slice(3)).toEqual([
      ['nhentai-1-6.webp'],
      ['nhentai-1-7.webp', 'nhentai-1-8.webp'],
    ]);
  });

  it('grows upload batches from one page up to eight', async () => {
    const staging = stagingFake();
    const service = new GalleryReaderService({
      sources: [sourceReturning(gallery(30))],
      http: { getImage: vi.fn(okImage) },
      prefetchPages: 10,
      cacheMaxBytes: 1024,
      maxImageBytes: 64,
      imageTimeoutMs: 1000,
      metadataTimeoutMs: 1000,
      staging,
      now: () => 0,
    });
    await service.loadPage('nhentai', '1', 1);
    await flush();
    expect(staging.calls.map((call) => call.length)).toEqual([1, 2, 4, 8, 6]);
  });

  it('serves a staged page synchronously only once its gallery is cached', async () => {
    const staging = stagingFake();
    const service = stagedReader(staging);
    expect(service.stagedPage('nhentai', '1', 2)).toBeUndefined();
    await service.loadPage('nhentai', '1', 1);
    await flush();
    expect(service.stagedPage('nhentai', '1', 2)).toEqual({
      status: 'ok',
      gallery: expect.objectContaining({ id: '1' }),
      page: 2,
      media: { kind: 'url', url: 'https://cdn.discordapp.com/nhentai-1-2.webp' },
    });
    expect(service.stagedPage('nhentai', '1', 9)).toBeUndefined();
  });

  it('does not start another upload while the window is still being staged', async () => {
    let release: () => void = () => undefined;
    const calls: string[][] = [];
    const staging: GalleryStagingPort = {
      stage: vi.fn(async (files: ReadonlyArray<{ name: string }>) => {
        calls.push(files.map((file) => file.name));
        await new Promise<void>((resolve) => (release = resolve));
        return files.map((file) => ({
          url: `https://cdn.discordapp.com/${file.name}`,
          expiresAt: 24 * 60 * 60 * 1000,
        }));
      }),
    };
    const service = stagedReader(staging);
    await service.loadPage('nhentai', '1', 1);
    await flush();
    await service.loadPage('nhentai', '1', 2);
    await flush();
    expect(calls).toEqual([['nhentai-1-2.webp']]);
    release();
  });

  it('does not reuse an upload whose URL is about to expire', async () => {
    const staging = stagingFake(30 * 60 * 1000);
    const service = stagedReader(staging);
    await service.loadPage('nhentai', '1', 1);
    await flush();
    const second = await service.loadPage('nhentai', '1', 2);
    expect(second.status === 'ok' && second.media.kind).toBe('file');
  });

  it('falls back to attaching bytes when staging fails', async () => {
    const staging: GalleryStagingPort = {
      stage: vi.fn(async (files: readonly unknown[]) => files.map(() => undefined)),
    };
    const service = stagedReader(staging);
    await service.loadPage('nhentai', '1', 1);
    await flush();
    const second = await service.loadPage('nhentai', '1', 2);
    expect(second.status === 'ok' && second.media.kind).toBe('file');
  });
});
