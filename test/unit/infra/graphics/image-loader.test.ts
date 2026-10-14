/**
 * Unit coverage for the remote image loader: every failure resolves to
 * `null` (host outside the allowlist, download error, undecodable body),
 * downloads respect the concurrency cap, decoded images are cached and
 * concurrent requests for one URL share a download, and failures are retried.
 */
import { createCanvas, Image } from 'canvas';
import { describe, expect, it, vi } from 'vitest';

import { createImageLoader } from '../../../../src/infra/graphics/image-loader';
import { boundedHttp } from '../../../../src/infra/http';

vi.mock('../../../../src/infra/http', () => ({ boundedHttp: { get: vi.fn() } }));

const PNG = createCanvas(4, 4).toBuffer('image/png');
const url = (name: string): string => `https://cdn.discordapp.com/emojis/${name}.png`;

const decoded = (): Image => {
  const image = new Image();
  image.src = PNG;
  return image;
};

describe('createImageLoader', () => {
  it('decodes a downloaded picture', async () => {
    const fetchBytes = vi.fn(async () => PNG);
    const image = await createImageLoader({ fetchBytes }).load(url('a'));
    expect(image?.width).toBe(4);
    expect(fetchBytes).toHaveBeenCalledWith(url('a'), 5_000);
  });

  it('downloads through the bounded HTTP client with a timeout and a size cap', async () => {
    vi.mocked(boundedHttp.get).mockResolvedValueOnce({
      data: PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength),
    });
    const image = await createImageLoader({ timeoutMs: 1_234 }).load(url('http'));
    expect(image).not.toBeNull();
    expect(boundedHttp.get).toHaveBeenCalledWith(url('http'), {
      responseType: 'arraybuffer',
      timeout: 1_234,
      signal: expect.any(AbortSignal),
      maxContentLength: 2 * 1024 * 1024,
      maxRedirects: 0,
    });
  });

  it.each([
    ['plain http', 'http://cdn.discordapp.com/emojis/a.png'],
    ['another host', 'https://evil.example/a.png'],
    ['not a URL', 'nope'],
  ])('refuses %s without a request', async (_, target) => {
    const fetchBytes = vi.fn(async () => PNG);
    expect(await createImageLoader({ fetchBytes }).load(target)).toBeNull();
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('resolves a failed download or decode to null and retries next time', async () => {
    const fetchBytes = vi
      .fn<(u: string, timeoutMs: number) => Promise<Buffer>>()
      .mockRejectedValueOnce(new Error('timeout of 5000ms exceeded'))
      .mockResolvedValue(PNG);
    const loader = createImageLoader({ fetchBytes });
    expect(await loader.load(url('a'))).toBeNull();
    expect(await loader.load(url('a'))).not.toBeNull();
    const broken = createImageLoader({ fetchBytes: async () => Buffer.from('not an image') });
    expect(await broken.load(url('b'))).toBeNull();
  });

  it('caches decoded images and shares one download between concurrent requests', async () => {
    const fetchBytes = vi.fn(async () => PNG);
    const loader = createImageLoader({ fetchBytes, decode: async () => decoded() });
    const [first, second] = await Promise.all([loader.load(url('a')), loader.load(url('a'))]);
    const third = await loader.load(url('a'));
    expect(first).toBe(second);
    expect(third).toBe(first);
    expect(fetchBytes).toHaveBeenCalledTimes(1);
  });

  it('evicts the least recently used image past the cache size', async () => {
    const fetchBytes = vi.fn(async (_u: string, _t: number) => PNG);
    const loader = createImageLoader({ fetchBytes, cacheSize: 2 });
    for (const name of ['a', 'b', 'a', 'c', 'a', 'b']) await loader.load(url(name));
    // `a` was used again before `c` arrived, so `b` was the one evicted.
    expect(fetchBytes.mock.calls.map(([target]) => target)).toEqual([
      url('a'),
      url('b'),
      url('c'),
      url('b'),
    ]);
  });

  it('refuses a picture larger than an emoji or sticker could be', async () => {
    const big = createCanvas(1_025, 8).toBuffer('image/png');
    expect(await createImageLoader({ fetchBytes: async () => big }).load(url('big'))).toBeNull();
  });

  it('logs failures at most once a minute per host with the suppressed count', async () => {
    const warn = vi.fn();
    let clock = 0;
    const loader = createImageLoader({
      fetchBytes: async () => {
        throw Object.assign(new Error('Request failed'), { response: { status: 404 } });
      },
      logger: { warn } as never,
      now: () => clock,
    });
    await loader.load(url('a'));
    await loader.load(url('b'));
    await loader.load(url('c'));
    clock = 61_000;
    await loader.load(url('d'));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toContain('cdn.discordapp.com (http-404); 0 more');
    expect(warn.mock.calls[1]?.[0]).toContain('2 more');
  });

  it('runs at most `concurrency` downloads at once', async () => {
    let active = 0;
    let peak = 0;
    const fetchBytes = async (): Promise<Buffer> => {
      active += 1;
      peak = Math.max(peak, active);
      // One event-loop turn lets every download the limiter admits start
      // before this one finishes, without depending on a timer.
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return PNG;
    };
    const loader = createImageLoader({ fetchBytes, concurrency: 2 });
    const images = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((n) => loader.load(url(n))));
    expect(images.every((image) => image !== null)).toBe(true);
    expect(peak).toBe(2);
  });
});
