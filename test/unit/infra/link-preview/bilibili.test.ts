/**
 * Unit tests for the Bilibili link-preview provider: host/path matching
 * (BV + av video ids across www/m/apex, plus `b23.tv` short links, rejecting
 * non-video pages and proxy hosts) and proxy-URL construction (host-swap,
 * `?p=` part selector preserved, every other tracking query param dropped).
 * A `b23.tv` link is first expanded to its canonical video URL via an injected
 * fake `OgClient.resolveCanonical` before the rewrite probe runs; a non-video
 * or failed resolution is skipped silently. The probe loop itself is
 * contract-tested via the shared rewrite-provider (Twitter stands in); here an
 * injected fake `OgClient` keeps the test offline and lets it assert the exact
 * candidate URL that gets probed.
 */
import { describe, expect, it, vi } from 'vitest';

import { createBilibiliProvider, invalidResponseError } from '../../../../src/infra/link-preview';
import { ok, err, type Result } from '../../../../src/core/result';
import type {
  LinkPreviewFailure,
  OgClient,
  OpenGraphMeta,
} from '../../../../src/infra/link-preview';

const u = (href: string): URL => new URL(href);

const provider = (ogClient: OgClient): ReturnType<typeof createBilibiliProvider> =>
  createBilibiliProvider({ proxyHosts: ['vxbilibili.com', 'bilibiliez.com'], ogClient });

/** Capture the candidate URLs the provider probes, always answering with a video hit. */
const recordingClient = (seen: string[]): OgClient =>
  ({
    fetch: vi.fn(async (url: string) => {
      seen.push(url);
      return ok({ images: [], video: 'v.mp4' } as OpenGraphMeta);
    }),
  }) as unknown as OgClient;

type ResolveResult = Result<string, LinkPreviewFailure>;

/** Fake OgClient exposing BOTH the b23 resolve step and the proxy OG probe. */
const makeB23Client = (opts: {
  resolve?: Readonly<Record<string, ResolveResult>>;
  seen?: string[];
}): {
  client: OgClient;
  fetch: ReturnType<typeof vi.fn>;
  resolveCanonical: ReturnType<typeof vi.fn>;
} => {
  const fetch = vi.fn(async (url: string) => {
    opts.seen?.push(url);
    return ok({ images: [], video: 'v.mp4' } as OpenGraphMeta);
  });
  const resolveCanonical = vi.fn(
    async (url: string): Promise<ResolveResult> =>
      opts.resolve?.[url] ?? err(invalidResponseError('bilibili')),
  );
  return { client: { fetch, resolveCanonical } as unknown as OgClient, fetch, resolveCanonical };
};

describe('createBilibiliProvider.canHandle', () => {
  const p = provider({ fetch: vi.fn(), resolveCanonical: vi.fn() } as unknown as OgClient);

  it('accepts BV / av video pages on www / m / apex hosts and b23.tv short links', () => {
    expect(p.canHandle(u('https://www.bilibili.com/video/BV1xx411c7mD'))).toBe(true);
    expect(p.canHandle(u('https://m.bilibili.com/video/BV1xx411c7mD'))).toBe(true);
    expect(p.canHandle(u('https://bilibili.com/video/av170001'))).toBe(true);
    expect(p.canHandle(u('https://www.bilibili.com/video/BV1xx411c7mD?p=2&spm_id_from=x'))).toBe(
      true,
    );
    expect(p.canHandle(u('https://b23.tv/mHCI3y3'))).toBe(true);
    expect(p.canHandle(u('https://www.b23.tv/mHCI3y3'))).toBe(true);
  });

  it('rejects non-video pages and proxy hosts', () => {
    expect(p.canHandle(u('https://www.bilibili.com/'))).toBe(false);
    expect(p.canHandle(u('https://space.bilibili.com/123'))).toBe(false);
    expect(p.canHandle(u('https://www.bilibili.com/bangumi/play/ep123'))).toBe(false);
    expect(p.canHandle(u('https://live.bilibili.com/123'))).toBe(false);
    // An already-fixed proxy link must be left alone (no re-rewrite loop).
    expect(p.canHandle(u('https://vxbilibili.com/video/BV1xx411c7mD'))).toBe(false);
  });
});

describe('createBilibiliProvider.build proxy URL', () => {
  it('host-swaps to the first proxy, preserving ?p= and dropping tracking query', async () => {
    const seen: string[] = [];
    const result = await provider(recordingClient(seen)).build(
      u('https://www.bilibili.com/video/BV1xx411c7mD?p=2&spm_id_from=333&vd_source=abc'),
      { timeoutMs: 1000 },
    );

    expect(seen[0]).toBe('https://vxbilibili.com/video/BV1xx411c7mD?p=2');
    if (result.ok && result.value?.kind === 'rewritten-url') {
      expect(result.value.url).toBe('https://vxbilibili.com/video/BV1xx411c7mD?p=2');
    } else {
      throw new Error('expected a rewritten-url result');
    }
  });

  it('drops the query entirely when no ?p= part selector is present', async () => {
    const seen: string[] = [];
    await provider(recordingClient(seen)).build(
      u('https://m.bilibili.com/video/BV1xx411c7mD?spm_id_from=333'),
      { timeoutMs: 1000 },
    );

    expect(seen[0]).toBe('https://vxbilibili.com/video/BV1xx411c7mD');
  });

  it('strips a trailing slash so the proxy URL is not 307-downgraded by vxbilibili', async () => {
    // vxbilibili answers `/video/<BV>/` with a 307 that downgrades to http://;
    // Discord refuses the https->http downgrade, so the canonical no-slash URL
    // must be posted instead.
    const seen: string[] = [];
    await provider(recordingClient(seen)).build(u('https://www.bilibili.com/video/BV1xx411c7mD/'), {
      timeoutMs: 1000,
    });

    expect(seen[0]).toBe('https://vxbilibili.com/video/BV1xx411c7mD');
  });

  it('strips the trailing slash while keeping the ?p= selector', async () => {
    const seen: string[] = [];
    await provider(recordingClient(seen)).build(
      u('https://www.bilibili.com/video/BV1xx411c7mD/?p=2'),
      { timeoutMs: 1000 },
    );

    expect(seen[0]).toBe('https://vxbilibili.com/video/BV1xx411c7mD?p=2');
  });
});

describe('createBilibiliProvider.build b23.tv resolution', () => {
  const B23 = 'https://b23.tv/mHCI3y3';

  it('resolves a b23.tv link then proxies the canonical video, carrying the short link as sourceUrl', async () => {
    const seen: string[] = [];
    const { client, resolveCanonical } = makeB23Client({
      resolve: { [B23]: ok('https://www.bilibili.com/video/BV1xx411c7mD') },
      seen,
    });
    const result = await provider(client).build(u(B23), { timeoutMs: 1000 });

    expect(resolveCanonical).toHaveBeenCalledWith(B23, 1000, 'bilibili');
    expect(seen[0]).toBe('https://vxbilibili.com/video/BV1xx411c7mD'); // probes the canonical, never the b23 token
    if (result.ok && result.value?.kind === 'rewritten-url') {
      expect(result.value.url).toBe('https://vxbilibili.com/video/BV1xx411c7mD');
      expect(result.value.sourceUrl).toBe(B23); // original short link is carried, not the canonical
    } else {
      throw new Error('expected a rewritten-url result');
    }
  });

  it('carries the ?p= part selector through resolution and drops tracking query', async () => {
    const seen: string[] = [];
    const { client } = makeB23Client({
      resolve: { [B23]: ok('https://www.bilibili.com/video/BV1xx411c7mD?p=3&spm_id_from=x') },
      seen,
    });
    await provider(client).build(u(B23), { timeoutMs: 1000 });

    expect(seen[0]).toBe('https://vxbilibili.com/video/BV1xx411c7mD?p=3');
  });

  it('skips silently when the b23.tv link resolves to a non-video page', async () => {
    const { client, fetch } = makeB23Client({
      resolve: { [B23]: ok('https://live.bilibili.com/123') },
    });
    const result = await provider(client).build(u(B23), { timeoutMs: 1000 });

    if (!result.ok) throw new Error('expected ok(null)');
    expect(result.value).toBeNull();
    expect(fetch).not.toHaveBeenCalled(); // no proxy probe for an unresolvable target
  });

  it('skips silently when b23.tv resolution fails', async () => {
    const { client, fetch } = makeB23Client({ resolve: {} }); // default: resolution error
    const result = await provider(client).build(u(B23), { timeoutMs: 1000 });

    if (!result.ok) throw new Error('expected ok(null)');
    expect(result.value).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not resolve a direct video link (probes it directly)', async () => {
    const seen: string[] = [];
    const { client, resolveCanonical } = makeB23Client({ seen });
    await provider(client).build(u('https://www.bilibili.com/video/BV1xx411c7mD'), {
      timeoutMs: 1000,
    });

    expect(resolveCanonical).not.toHaveBeenCalled();
    expect(seen[0]).toBe('https://vxbilibili.com/video/BV1xx411c7mD');
  });
});
