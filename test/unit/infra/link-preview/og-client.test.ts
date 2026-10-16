/**
 * Unit tests for {@link parseOpenGraph} (pure) and {@link OgClient.fetch}
 * (axios auto-mocked, reassigning `axios.get` per case — the
 * `selfhosted-client` pattern). `fetch` streams the response and classifies
 * it by Content-Type, so the mock returns a Readable plus headers. Covers
 * tag mapping, entity decoding, first-occurrence precedence, media-type
 * classification, head-only streaming of a large body, and the
 * transport/HTTP failure mapping. Also covers {@link createBoundedLookup},
 * the c-ares-backed `lookup` the client's agents resolve through.
 */
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { OgClient, parseOpenGraph } from '../../../../src/infra/link-preview';
import {
  createBoundedLookup,
  isUnsafeRedirectHost,
  type AddressResolver,
} from '../../../../src/infra/link-preview/og-client';
import { isErr, isOk } from '../../../../src/core/result';

vi.mock('axios');

const setGet = (impl: (...args: unknown[]) => Promise<unknown>): ReturnType<typeof vi.fn> => {
  const get = vi.fn(impl);
  (axios.get as unknown as ReturnType<typeof vi.fn>) = get;
  return get;
};

const html = (head: string): string => `<html><head>${head}</head><body>ignored</body></html>`;

/**
 * Build a streamed axios-style response. `body` is split into the supplied
 * chunks (default: one); `contentType` drives the classification path;
 * `finalUrl` mimics the http adapter's post-redirect `responseUrl`.
 */
const streamResponse = (
  body: string | readonly Buffer[],
  contentType = 'text/html; charset=utf-8',
  finalUrl = 'https://gamer.com.tw/x',
): {
  data: Readable;
  headers: Record<string, string>;
  request: { res: { responseUrl: string } };
} => ({
  data: Readable.from(typeof body === 'string' ? [Buffer.from(body, 'utf8')] : [...body]),
  headers: { 'content-type': contentType },
  request: { res: { responseUrl: finalUrl } },
});

describe('parseOpenGraph', () => {
  it('retains only explicitly supplied author metadata', () => {
    const meta = parseOpenGraph(
      html(
        '<meta name="author" content="Example Author"><meta property="article:author" content="https://www.facebook.com/author">',
      ),
    );
    expect(meta.authorName).toBe('Example Author');
    expect(meta.authorUrl).toBe('https://www.facebook.com/author');
    expect(
      parseOpenGraph(html('<meta property="og:title" content="Reel by Example">')).authorName,
    ).toBeUndefined();
  });

  it('maps og:title / description / image / url / site_name', () => {
    const meta = parseOpenGraph(
      html(
        [
          '<meta property="og:title" content="A Title">',
          '<meta property="og:description" content="A description">',
          '<meta property="og:image" content="https://cdn.example/a.jpg">',
          '<meta property="og:url" content="https://example.com/post/1">',
          '<meta property="og:site_name" content="Example">',
        ].join(''),
      ),
    );
    expect(meta).toEqual({
      title: 'A Title',
      description: 'A description',
      images: ['https://cdn.example/a.jpg'],
      video: undefined,
      url: 'https://example.com/post/1',
      siteName: 'Example',
    });
  });

  it('extracts the video URL (og:video:secure_url > og:video:url > og:video)', () => {
    const meta = parseOpenGraph(
      html(
        [
          '<meta property="og:video" content="http://cdn/v-plain.mp4">',
          '<meta property="og:video:url" content="http://cdn/v-url.mp4">',
          '<meta property="og:video:secure_url" content="https://cdn/v-secure.mp4">',
        ].join(''),
      ),
    );
    expect(meta.video).toBe('https://cdn/v-secure.mp4');
  });

  it('collects ALL images in document order, de-duplicated', () => {
    const meta = parseOpenGraph(
      html(
        [
          '<meta property="og:image" content="https://cdn/1.jpg">',
          '<meta property="og:image" content="https://cdn/2.jpg">',
          '<meta property="og:image" content="https://cdn/1.jpg">',
        ].join(''),
      ),
    );
    expect(meta.images).toEqual(['https://cdn/1.jpg', 'https://cdn/2.jpg']);
  });

  it('handles content-before-property attribute order', () => {
    const meta = parseOpenGraph(html('<meta content="Reversed" property="og:title">'));
    expect(meta.title).toBe('Reversed');
  });

  it('parses unquoted attribute values and a missing space before the next attribute (vxbilibili)', () => {
    // vxbilibili emits unquoted OpenGraph attributes (an og:image URL keeps
    // its `:` and `/`) and sometimes omits the space between a quoted content
    // value and the following unquoted `property=` — a quoted-only matcher
    // skipped every such tag, so the preview yielded nothing.
    const meta = parseOpenGraph(
      html(
        [
          '<meta content=http://i0.hdslb.com/bfs/archive/abc.jpg property=og:image>',
          '<meta content="https://media.vxbilibili.com/video/BV1/1?_=x"property=og:video>',
          '<meta content=PlainTitle property=og:title>',
        ].join(''),
      ),
    );
    expect(meta.video).toBe('https://media.vxbilibili.com/video/BV1/1?_=x');
    expect(meta.images).toEqual(['http://i0.hdslb.com/bfs/archive/abc.jpg']);
    expect(meta.title).toBe('PlainTitle');
  });

  it('falls back to twitter:* when og:* is absent', () => {
    const meta = parseOpenGraph(
      html(
        '<meta name="twitter:title" content="TW Title"><meta name="twitter:image" content="https://cdn/t.jpg">',
      ),
    );
    expect(meta.title).toBe('TW Title');
    expect(meta.images).toEqual(['https://cdn/t.jpg']);
  });

  it('prefers og:* over twitter:* for the same field', () => {
    const meta = parseOpenGraph(
      html('<meta property="og:title" content="OG"><meta name="twitter:title" content="TW">'),
    );
    expect(meta.title).toBe('OG');
  });

  it('keeps the first occurrence of a duplicated scalar tag', () => {
    const meta = parseOpenGraph(
      html('<meta property="og:title" content="first"><meta property="og:title" content="second">'),
    );
    expect(meta.title).toBe('first');
  });

  it('decodes named HTML entities in content', () => {
    const meta = parseOpenGraph(
      html('<meta property="og:title" content="Tom &amp; Jerry &#39;95 &quot;quoted&quot;">'),
    );
    expect(meta.title).toBe('Tom & Jerry \'95 "quoted"');
  });

  it('decodes numeric and hex entities and leaves malformed ones verbatim', () => {
    const meta = parseOpenGraph(
      html('<meta property="og:title" content="&#8364; &#x1F600; &#xZZ;">'),
    );
    expect(meta.title).toBe('€ 😀 &#xZZ;');
  });

  it('ignores meta tags after </head>', () => {
    const withBodyMeta =
      '<html><head><meta property="og:title" content="Head"></head><body><meta property="og:title" content="Body"></body></html>';
    expect(parseOpenGraph(withBodyMeta).title).toBe('Head');
  });

  it('returns empty images and all-undefined scalars when no og/twitter tags are present', () => {
    const meta = parseOpenGraph(html('<meta charset="utf-8"><title>plain</title>'));
    expect(meta).toEqual({
      title: undefined,
      description: undefined,
      images: [],
      video: undefined,
      url: undefined,
      siteName: undefined,
    });
  });
});

describe('OgClient.fetch', () => {
  it('fetches with SSRF-safe streaming options and returns parsed metadata (happy path)', async () => {
    const get = setGet(async () =>
      streamResponse(
        html('<meta property="og:title" content="Hi"><meta property="og:image" content="i.jpg">'),
      ),
    );
    const result = await new OgClient().fetch('https://gamer.com.tw/x', 'bahamut', 4000);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.title).toBe('Hi');
      expect(result.value.images).toEqual(['i.jpg']);
    }
    expect(get).toHaveBeenCalledWith(
      'https://gamer.com.tw/x',
      expect.objectContaining({
        timeout: 4000,
        // Bounded redirect-following (proxies redirect to a render/CDN host);
        // the beforeRedirect guard refuses internal hops.
        maxRedirects: 3,
        beforeRedirect: expect.any(Function),
        // Agents carrying the bounded DNS lookup, for the first hop and every
        // redirect hop alike.
        httpAgent: expect.any(http.Agent),
        httpsAgent: expect.any(https.Agent),
        // Streamed so a media body is never pulled and a large HTML body is
        // read only up to its <head>.
        responseType: 'stream',
        // Default UA must be the Discord crawler UA so proxies serve OG and
        // we see exactly what Discord's unfurl will fetch.
        headers: expect.objectContaining({
          'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
          Accept: 'text/html',
        }),
      }),
    );
  });

  it('classifies a video Content-Type as a playable preview without reading the body', async () => {
    const body = Buffer.alloc(4 * 1024 * 1024, 0); // 4 MiB "video" — must NOT be buffered
    const response = streamResponse(
      [body],
      'video/mp4',
      'https://scontent.cdninstagram.com/reel.mp4',
    );
    setGet(async () => response);
    const result = await new OgClient().fetch('https://kkinstagram.com/reel/X/', 'instagram', 4000);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.video).toBe('https://scontent.cdninstagram.com/reel.mp4');
      expect(result.value.images).toEqual([]);
      expect(result.value.finalUrl).toBe('https://scontent.cdninstagram.com/reel.mp4');
    }
    expect(response.data.destroyed).toBe(true); // never drained the 4 MiB body
  });

  it('classifies an image Content-Type as an image preview (final URL)', async () => {
    const response = streamResponse(
      [Buffer.from('binary')],
      'image/jpeg',
      'https://cdn.example/photo.jpg',
    );
    setGet(async () => response);
    const result = await new OgClient().fetch('https://kkinstagram.com/p/X/', 'instagram', 4000);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.images).toEqual(['https://cdn.example/photo.jpg']);
      expect(result.value.finalUrl).toBe('https://cdn.example/photo.jpg');
    }
  });

  it('reports the URL an HTML page was finally served from, after redirects', async () => {
    // A proxy that 302s back to instagram.com: the metadata is real, but the
    // rewrite provider must be able to see it did not come from the proxy.
    setGet(async () =>
      streamResponse(
        html('<meta property="og:image" content="https://scontent.cdninstagram.com/i.jpg">'),
        'text/html; charset=utf-8',
        'https://www.instagram.com/reel/X/',
      ),
    );
    const result = await new OgClient().fetch(
      'https://mbdinstagram.com/reel/X/',
      'instagram',
      4000,
    );

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.images).toEqual(['https://scontent.cdninstagram.com/i.jpg']);
      expect(result.value.finalUrl).toBe('https://www.instagram.com/reel/X/');
    }
  });

  it('treats a redirect to a media file the host cannot reach as that media, final URL included', async () => {
    setGet(async (...args: unknown[]) => {
      const { beforeRedirect } = args[1] as {
        beforeRedirect: (options: Record<string, string>) => void;
      };
      beforeRedirect({
        protocol: 'https:',
        hostname: 'scontent.cdninstagram.com',
        path: '/v/reel.mp4',
      });
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    });
    const result = await new OgClient().fetch('https://kkinstagram.com/reel/X/', 'instagram', 4000);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.video).toBe('https://scontent.cdninstagram.com/v/reel.mp4');
      expect(result.value.finalUrl).toBe('https://scontent.cdninstagram.com/v/reel.mp4');
    }
  });

  it('reads only the head of a large HTML body — never buffers it, never throws', async () => {
    // og:title sits in the first chunk; the rest dwarfs the byte cap and has
    // no </head>, so the read must stop at the cap rather than buffering (or
    // rejecting) a body this large.
    const head = Buffer.from('<html><head><meta property="og:title" content="Big">');
    const filler = Buffer.alloc(50_000, 0x78); // 'x'
    const response = streamResponse([head, filler, filler, filler], 'text/html');
    setGet(async () => response);
    const result = await new OgClient({ maxContentLength: 1024 }).fetch(
      'https://gamer.com.tw/x',
      'bahamut',
      4000,
    );

    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value.title).toBe('Big');
    expect(response.data.destroyed).toBe(true); // stopped early, did not drain
  });

  it('honours a custom User-Agent option', async () => {
    const get = setGet(async () => streamResponse(html('<meta property="og:title" content="x">')));
    await new OgClient({ userAgent: 'Custom-UA/9' }).fetch(
      'https://gamer.com.tw/x',
      'bahamut',
      1000,
    );
    expect(get).toHaveBeenCalledWith(
      'https://gamer.com.tw/x',
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': 'Custom-UA/9' }),
      }),
    );
  });

  it('maps ECONNABORTED to LINK_PREVIEW_TIMEOUT', async () => {
    setGet(async () => {
      throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
    });
    const result = await new OgClient().fetch('https://gamer.com.tw/x', 'bahamut', 1000);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('LINK_PREVIEW_TIMEOUT');
  });

  it('maps HTTP 429 to LINK_PREVIEW_RATE_LIMITED', async () => {
    setGet(async () => {
      throw Object.assign(new Error('429'), { response: { status: 429 } });
    });
    const result = await new OgClient().fetch('https://gamer.com.tw/x', 'bahamut', 1000);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('LINK_PREVIEW_RATE_LIMITED');
  });

  it('maps HTTP 503 to LINK_PREVIEW_UPSTREAM_5XX and preserves cause', async () => {
    const cause = Object.assign(new Error('down'), { response: { status: 503 } });
    setGet(async () => {
      throw cause;
    });
    const result = await new OgClient().fetch('https://gamer.com.tw/x', 'bahamut', 1000);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('LINK_PREVIEW_UPSTREAM_5XX');
      expect(result.error.cause).toBe(cause);
    }
  });

  it('maps a generic transport error to LINK_PREVIEW_FETCH_FAILED', async () => {
    setGet(async () => {
      throw Object.assign(new Error('dns'), { code: 'ENOTFOUND' });
    });
    const result = await new OgClient().fetch('https://gamer.com.tw/x', 'bahamut', 1000);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('LINK_PREVIEW_FETCH_FAILED');
  });
});

describe('OgClient.resolveCanonical', () => {
  const share = 'https://www.facebook.com/share/r/1AcYfs5CNq/';
  const canonical = 'https://www.facebook.com/61585725097605/videos/866774919797953/';

  it('follows redirects with a browser UA and returns the final URL (body discarded)', async () => {
    const response = streamResponse([Buffer.from('error page')], 'text/html', canonical);
    const get = setGet(async () => response);
    const result = await new OgClient().resolveCanonical(share, 4000);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toBe(canonical);
    // Only the post-redirect URL matters: the destination body is never read.
    expect(response.data.destroyed).toBe(true);
    expect(get).toHaveBeenCalledWith(
      share,
      expect.objectContaining({
        timeout: 4000,
        maxRedirects: 3,
        beforeRedirect: expect.any(Function),
        responseType: 'stream',
        // A non-crawler UA: Facebook only redirects share links to the
        // canonical permalink for a browser-like UA (NOT the Discord crawler).
        headers: expect.objectContaining({
          'User-Agent': expect.stringContaining('Chrome/'),
          Accept: 'text/html',
        }),
      }),
    );
    const ua = (get.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers[
      'User-Agent'
    ];
    expect(ua).not.toContain('Discordbot');
  });

  it('maps a transport error to an Err (LINK_PREVIEW_FETCH_FAILED)', async () => {
    setGet(async () => {
      throw Object.assign(new Error('dns'), { code: 'ENOTFOUND' });
    });
    const result = await new OgClient().resolveCanonical(share, 1000);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('LINK_PREVIEW_FETCH_FAILED');
  });
});

describe('OgClient.resolveRedirectChain', () => {
  // A Threads share link: the legacy host 301s to the current one, that hop
  // 302s to the permalink, and the single-use `xmt` token in it is rejected on
  // the follow-up request — so the permalink survives only as an intermediate
  // hop and the chase lands on a generic error page.
  const share = 'https://www.threads.net/share/BAc3zqH7qQ/';
  const currentHost = 'https://www.threads.com/share/BAc3zqH7qQ/';
  const permalink = 'https://www.threads.com/@ajit86403/post/Dcp0Ly0iOIq?xmt=AQG0S6Tr0&slof=1';
  const landing = 'https://www.threads.com/?error=invalid_post';
  // Threads answers a full desktop-browser UA with its client-side-routed app
  // shell (200, no Location); a plainer UA still gets the 30x.
  const minimalUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

  /** A `beforeRedirect` options bag as the http adapter builds it for one hop. */
  const hopOptions = (target: string): Record<string, string> => {
    const url = new URL(target);
    return {
      protocol: url.protocol,
      hostname: url.hostname,
      host: url.host,
      path: `${url.pathname}${url.search}`,
    };
  };

  /**
   * Fake `axios.get` that replays `hops` through the caller's `beforeRedirect`
   * — exactly as the http adapter does on each 30x — before settling with
   * `settle` (a response, or a throw standing in for a transport failure).
   */
  const setChasingGet = (
    hops: readonly string[],
    settle: () => Promise<unknown>,
  ): ReturnType<typeof vi.fn> =>
    setGet(async (...args: unknown[]) => {
      const { beforeRedirect } = args[1] as {
        beforeRedirect: (options: Record<string, string>) => void;
      };
      for (const hop of hops) beforeRedirect(hopOptions(hop));
      return settle();
    });

  it('returns every recorded hop in order', async () => {
    const response = streamResponse([Buffer.from('error page')], 'text/html', landing);
    setChasingGet([currentHost, permalink, landing], async () => response);
    const result = await new OgClient().resolveRedirectChain(share, 4000, 'threads');

    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toEqual([currentHost, permalink, landing]);
  });

  it('returns an empty array when the response did not redirect', async () => {
    setChasingGet([], async () => streamResponse([Buffer.from('shell')], 'text/html', share));
    const result = await new OgClient().resolveRedirectChain(share, 4000, 'threads');

    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toEqual([]);
  });

  it('discards the destination body — only the hop URLs matter', async () => {
    const response = streamResponse([Buffer.alloc(64 * 1024, 0x78)], 'text/html', landing);
    setChasingGet([permalink, landing], async () => response);
    await new OgClient().resolveRedirectChain(share, 4000, 'threads');

    expect(response.data.destroyed).toBe(true);
  });

  it('refuses a hop targeting a private / loopback host (SSRF guard)', async () => {
    setChasingGet(['http://127.0.0.1/admin'], async () =>
      streamResponse([Buffer.from('never reached')], 'text/html', landing),
    );
    const result = await new OgClient().resolveRedirectChain(share, 4000, 'threads');

    // The guard throws before the hop is recorded, so nothing can be salvaged.
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('LINK_PREVIEW_FETCH_FAILED');
      expect((result.error.cause as Error).message).toContain(
        'refusing redirect to disallowed host',
      );
    }
  });

  it('salvages the recorded hops when the chase fails after a hop', async () => {
    // The load-bearing Threads case: the permalink hop is already recorded when
    // the rejected share token bounces the chase, so the caller still gets it.
    setChasingGet([currentHost, permalink], async () => {
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    });
    const result = await new OgClient().resolveRedirectChain(share, 4000, 'threads');

    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toEqual([currentHost, permalink]);
  });

  it('maps a transport failure with no recorded hop to LINK_PREVIEW_FETCH_FAILED', async () => {
    setChasingGet([], async () => {
      throw Object.assign(new Error('dns'), { code: 'ENOTFOUND' });
    });
    const result = await new OgClient().resolveRedirectChain(share, 1000, 'threads');

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('LINK_PREVIEW_FETCH_FAILED');
  });

  it('honours the userAgent argument and keeps the house request options', async () => {
    const get = setChasingGet([permalink], async () =>
      streamResponse([Buffer.from('page')], 'text/html', permalink),
    );
    await new OgClient().resolveRedirectChain(share, 4000, 'threads', minimalUa);

    expect(get).toHaveBeenCalledWith(
      share,
      expect.objectContaining({
        timeout: 4000,
        maxRedirects: 3,
        beforeRedirect: expect.any(Function),
        responseType: 'stream',
        headers: expect.objectContaining({ 'User-Agent': minimalUa, Accept: 'text/html' }),
      }),
    );
  });

  it('defaults to the same browser UA resolveCanonical sends', async () => {
    const get = setChasingGet([], async () =>
      streamResponse([Buffer.from('page')], 'text/html', share),
    );
    await new OgClient().resolveCanonical(share, 1000);
    await new OgClient().resolveRedirectChain(share, 1000, 'threads');

    const uaOf = (call: number): string =>
      (get.mock.calls[call]?.[1] as { headers: Record<string, string> }).headers['User-Agent'] ??
      '';
    expect(uaOf(1)).toBe(uaOf(0));
    expect(uaOf(1)).toContain('Chrome/');
  });
});

describe('OgClient cache', () => {
  // A fresh single-use stream per call so a cache hit is observable as a
  // SKIPPED network call (Readable is consumed once).
  const okStream = (): Promise<unknown> =>
    Promise.resolve(streamResponse(html('<meta property="og:title" content="Hi">')));

  it('serves a second fetch of the same URL from cache (one network call)', async () => {
    const get = setGet(okStream);
    const client = new OgClient({ cacheTtlMs: 60_000, now: () => 1000 });
    await client.fetch('https://gamer.com.tw/x', 'bahamut', 1000);
    await client.fetch('https://gamer.com.tw/x', 'bahamut', 1000);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache an error result (next call re-hits the network)', async () => {
    const get = setGet(async () => {
      throw Object.assign(new Error('boom'), { code: 'ENOTFOUND' });
    });
    const client = new OgClient({ cacheTtlMs: 60_000, now: () => 1000 });
    await client.fetch('https://gamer.com.tw/x', 'bahamut', 1000);
    await client.fetch('https://gamer.com.tw/x', 'bahamut', 1000);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('re-fetches after the TTL expires', async () => {
    const get = setGet(okStream);
    let clock = 1000;
    const client = new OgClient({ cacheTtlMs: 10_000, now: () => clock });
    await client.fetch('https://gamer.com.tw/x', 'bahamut', 1000);
    clock = 1000 + 10_001; // past TTL
    await client.fetch('https://gamer.com.tw/x', 'bahamut', 1000);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest entry past the max-entry cap', async () => {
    const get = setGet(okStream);
    const client = new OgClient({ cacheTtlMs: 60_000, cacheMaxEntries: 1, now: () => 1000 });
    await client.fetch('https://gamer.com.tw/a', 'bahamut', 1000); // fills cache
    await client.fetch('https://gamer.com.tw/b', 'bahamut', 1000); // evicts /a
    await client.fetch('https://gamer.com.tw/a', 'bahamut', 1000); // miss again
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('is disabled by default (every call hits the network)', async () => {
    const get = setGet(okStream);
    const client = new OgClient();
    await client.fetch('https://gamer.com.tw/x', 'bahamut', 1000);
    await client.fetch('https://gamer.com.tw/x', 'bahamut', 1000);
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe('isUnsafeRedirectHost (SSRF guard)', () => {
  it('blocks loopback / private / link-local / unspecified / CGNAT IPv4', () => {
    for (const host of [
      '127.0.0.1',
      '10.0.0.5',
      '192.168.1.1',
      '172.16.0.1',
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1', // CGNAT (RFC 6598)
    ]) {
      expect(isUnsafeRedirectHost(host)).toBe(true);
    }
  });

  it('blocks non-canonical numeric IPv4 encodings (decimal / hex / octal / short)', () => {
    for (const host of ['2130706433', '0x7f000001', '010.0.0.1', '127.1']) {
      expect(isUnsafeRedirectHost(host)).toBe(true);
    }
  });

  it('blocks loopback / ULA / link-local IPv6 in any textual form', () => {
    for (const host of [
      '::1',
      '::',
      'fc00::1',
      'fd12::34',
      'fe80::1',
      '[::1]',
      'FE80::1',
      'fe80:0:0::1',
      '0:0:0:0:0:0:0:1', // expanded loopback
      'fe80::1%eth0', // zone id
    ]) {
      expect(isUnsafeRedirectHost(host)).toBe(true);
    }
  });

  it('blocks IPv4-mapped / -compatible IPv6 and NAT64 reaching an internal IPv4', () => {
    for (const host of [
      '::ffff:127.0.0.1',
      '::ffff:7f00:1', // hex form of ::ffff:127.0.0.1
      '::ffff:169.254.169.254',
      '[::ffff:169.254.169.254]',
      '::127.0.0.1', // IPv4-compatible
      '64:ff9b::7f00:1', // NAT64 -> 127.0.0.1
    ]) {
      expect(isUnsafeRedirectHost(host)).toBe(true);
    }
  });

  it('blocks internal hostnames', () => {
    for (const host of ['localhost', 'db.internal', 'service.local', 'foo.localhost']) {
      expect(isUnsafeRedirectHost(host)).toBe(true);
    }
  });

  it('blocks trailing-dot (FQDN root) forms that resolve identically', () => {
    for (const host of [
      'localhost.',
      'db.internal.',
      'service.local.',
      '127.0.0.1.',
      '169.254.169.254.',
    ]) {
      expect(isUnsafeRedirectHost(host)).toBe(true);
    }
  });

  it('allows public hostnames and public IPs (incl. a public IPv4-mapped IPv6)', () => {
    for (const host of [
      'kkclip.com',
      'fxtwitter.com',
      'example.com',
      '1.1.1.1',
      '8.8.8.8',
      '172.32.0.1', // just outside the 172.16/12 private block
      '::ffff:8.8.8.8', // public IPv4 mapped -> allowed
    ]) {
      expect(isUnsafeRedirectHost(host)).toBe(false);
    }
  });
});

describe('createBoundedLookup', () => {
  type LookupResult = {
    err: NodeJS.ErrnoException | null;
    address: string | { address: string; family: number }[];
    family: number | undefined;
  };

  const resolver = (impl: Partial<AddressResolver>): AddressResolver => ({
    resolve4: impl.resolve4 ?? vi.fn(async () => []),
    resolve6: impl.resolve6 ?? vi.fn(async () => []),
  });

  const lookup = (
    r: AddressResolver,
    options: Parameters<ReturnType<typeof createBoundedLookup>>[1],
  ): Promise<LookupResult> =>
    new Promise((resolve) => {
      createBoundedLookup(r)('proxy.example', options, (err, address, family) =>
        resolve({ err, address, family }),
      );
    });

  const timeout = (): Promise<never> =>
    Promise.reject(Object.assign(new Error('queryA ETIMEOUT proxy.example'), { code: 'ETIMEOUT' }));
  const noData = (): Promise<never> =>
    Promise.reject(
      Object.assign(new Error('queryAaaa ENODATA proxy.example'), { code: 'ENODATA' }),
    );

  it('returns the first address (IPv4 before IPv6) when the socket asks for one', async () => {
    const r = resolver({
      resolve4: vi.fn(async () => ['203.0.113.7']),
      resolve6: vi.fn(async () => ['2001:db8::7']),
    });
    const result = await lookup(r, { family: 0 });
    expect(result).toEqual({ err: null, address: '203.0.113.7', family: 4 });
  });

  it('returns every address of both families when the socket asks for all', async () => {
    const r = resolver({
      resolve4: vi.fn(async () => ['203.0.113.7', '203.0.113.8']),
      resolve6: vi.fn(async () => ['2001:db8::7']),
    });
    const result = await lookup(r, { family: 0, all: true });
    expect(result.err).toBeNull();
    expect(result.address).toEqual([
      { address: '203.0.113.7', family: 4 },
      { address: '203.0.113.8', family: 4 },
      { address: '2001:db8::7', family: 6 },
    ]);
  });

  it('queries only the requested family', async () => {
    const resolve4 = vi.fn(async () => ['203.0.113.7']);
    const resolve6 = vi.fn(async () => ['2001:db8::7']);
    const result = await lookup(resolver({ resolve4, resolve6 }), { family: 6 });
    expect(result).toEqual({ err: null, address: '2001:db8::7', family: 6 });
    expect(resolve4).not.toHaveBeenCalled();

    const v4 = await lookup(resolver({ resolve4, resolve6 }), { family: 'IPv4' });
    expect(v4.address).toBe('203.0.113.7');
  });

  it('still answers when one family fails and the other resolves', async () => {
    const r = resolver({ resolve4: vi.fn(async () => ['203.0.113.7']), resolve6: noData });
    const result = await lookup(r, { family: 0, all: true });
    expect(result.err).toBeNull();
    expect(result.address).toEqual([{ address: '203.0.113.7', family: 4 }]);
  });

  it("reports a dead name server as ETIMEOUT, ahead of the other family's failure", async () => {
    const r = resolver({ resolve4: noData, resolve6: timeout });
    const result = await lookup(r, { family: 0 });
    expect(result.err?.code).toBe('ETIMEOUT');
  });

  it('reports an empty answer as ENOTFOUND', async () => {
    const r = resolver({ resolve4: vi.fn(async () => []), resolve6: vi.fn(async () => []) });
    const result = await lookup(r, { family: 0 });
    expect(result.err?.code).toBe('ENOTFOUND');
    expect(result.err?.message).toContain('proxy.example');
  });

  it('wraps a non-Error rejection as ENOTFOUND rather than passing it through', async () => {
    const r = resolver({
      resolve4: vi.fn(async () => Promise.reject('string reason')),
      resolve6: vi.fn(async () => Promise.reject('string reason')),
    });
    const result = await lookup(r, { family: 0 });
    expect(result.err).toBeInstanceOf(Error);
    expect(result.err?.code).toBe('ENOTFOUND');
  });
});
