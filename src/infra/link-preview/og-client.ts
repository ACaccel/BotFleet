/**
 * OgClient — SSRF-safe OpenGraph metadata fetcher.
 *
 * The single network boundary for the link-preview layer. Two callers:
 *   - the rewrite providers, which fetch each candidate proxy URL to
 *     VALIDATE (before posting) that Discord will get media — using the
 *     Discord crawler UA so we observe exactly what Discord's unfurl sees;
 *   - the Bahamut provider, which scrapes the source page's OpenGraph;
 *   - the X provider, which reads a post from a JSON API ({@link OgClient.fetchJson}).
 * Modeled on `infra/llm/selfhosted-client.ts`: axios + Result + the shared
 * {@link translateLinkPreviewError}. Never throws a `DomainError` — every
 * failure lands on the Result's Err rail so the caller can stay silent.
 *
 * What Discord's unfurl actually accepts — and what we must mirror to
 * validate faithfully — is one of two things at the proxy URL:
 *   1. an HTML page carrying OpenGraph tags (most proxies), or
 *   2. a redirect (for a bot UA) straight to a `video/*` / `image/*` file
 *      that Discord embeds directly (e.g. `kkinstagram` 302s a reel to a
 *      `*.mp4` on the Instagram CDN).
 * So the response is classified by its final `Content-Type`: a media type
 * is itself a valid playable preview (no body is downloaded), otherwise the
 * body is treated as HTML and only its `<head>` is read for `<meta>` tags.
 * The URL the response was finally served from is reported alongside
 * (`finalUrl`): a proxy that cannot fetch a post tends to redirect back to
 * the source site, and what the source then serves THIS host says nothing
 * about what it will serve Discord's crawler — the rewrite providers use
 * `finalUrl` to recognise and skip that case.
 *
 * SSRF mitigations (the initial host always comes from the operator's
 * configured proxy-host allow-list, or the provider's `canHandle` host
 * allow-list — never arbitrary user input; only the path/query is
 * user-derived):
 *   - Follow at most {@link SAFE_MAX_REDIRECTS} redirects (proxies redirect
 *     to a render / CDN host, and Discord's crawler follows them — so we
 *     must too, or validation false-negatives), but the `beforeRedirect`
 *     guard rejects any hop targeting a private / loopback / link-local
 *     address or a non-`http(s)` scheme. So a crafted redirect to an
 *     internal address still cannot be chased.
 *   - Response is streamed and read incrementally: a media `Content-Type`
 *     is classified from headers alone (the multi-MB body is never pulled),
 *     and an HTML body is read only up to the `<head>` close or a byte cap,
 *     so a hostile or huge page cannot exhaust memory.
 *   - `timeout` bounds time-to-headers; an explicit read deadline bounds the
 *     body read, so a slow trickle cannot stall the event handler.
 *
 * Name resolution is bounded separately, because the request timeout
 * cannot reach it: Node's default `dns.lookup` runs `getaddrinfo` on the
 * libuv threadpool, where a query to a host whose name servers have gone
 * silent (a dead embed proxy, typically) holds a thread for tens of seconds
 * after axios has already given up. A few such probes fill the pool and
 * every other lookup in the process — the Discord API, the database, the
 * LLM providers — queues behind them. So every probe resolves through a
 * c-ares resolver with its own per-query timeout, off the threadpool (see
 * {@link createBoundedLookup}); a dead proxy costs one short DNS timeout
 * and nothing else.
 * Only the `<head>` is scanned for `<meta>` tags via a bounded regex, so
 * no heavy HTML parser dependency is introduced.
 */
import { promises as dnsPromises, type LookupAddress, type LookupOptions } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import axios from 'axios';

import { ok, err, type Result } from '../../core/result';

import { translateLinkPreviewError } from './error-translator';
import type { LinkPreviewFailure } from './types';

/** Subset of OpenGraph / Twitter-card tags we map into a preview. */
export interface OpenGraphMeta {
  readonly title?: string;
  readonly description?: string;
  /** All `og:image*` / `twitter:image` URLs in first-seen order; `[]` when none. */
  readonly images: readonly string[];
  /** Best video URL (`og:video:secure_url` > `og:video:url` > `og:video`), if any. */
  readonly video?: string;
  readonly url?: string;
  readonly siteName?: string;
  readonly authorName?: string;
  readonly authorUrl?: string;
  /**
   * URL the response was ultimately served from, after redirects (the
   * requested URL when there were none). Absent from a pure
   * {@link parseOpenGraph} result; `fetch` always sets it so a caller can
   * tell a proxy that served the page itself from one that redirected
   * elsewhere — in particular back to the source site.
   */
  readonly finalUrl?: string;
}

interface OgClientOptions {
  /**
   * Cap on the bytes read from an HTML body while scanning for `</head>`,
   * in bytes. The body is streamed and reading stops at the head close or
   * this cap (whichever comes first), so a multi-MB page (e.g. the ~900 KB
   * `instagram.com` fallback) never buffers in full. Media responses are
   * classified from headers and read no body at all. Default 512 KiB.
   */
  readonly maxContentLength?: number;
  /**
   * User-Agent sent with the request. Defaults to the Discord crawler UA
   * so embed-proxy hosts serve OpenGraph (they gate it behind a bot UA)
   * and we see exactly what Discord's crawler will see. Overridable for tests.
   */
  readonly userAgent?: string;
  /**
   * When > 0, successful fetches are cached by URL for this many ms. The
   * provider validation loop fans out across several proxy hosts per
   * message, so a small cache avoids hammering flaky proxies with repeated
   * probes for the same link. Default 0 (disabled) — tests opt in.
   */
  readonly cacheTtlMs?: number;
  /** Max cache entries before the oldest is evicted (FIFO). Default 256. */
  readonly cacheMaxEntries?: number;
  /** Injectable clock for deterministic cache-expiry tests. Default `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_MAX_CONTENT_LENGTH = 512 * 1024;
/**
 * First-attempt timeout of a probe's DNS query. Short because the hosts in
 * play are public, well-provisioned names: an answer that takes longer is
 * almost always a dead name server. c-ares doubles the wait on the retry,
 * so a silent name server costs about three seconds in total — inside the
 * operator's per-host request timeout, which would otherwise absorb the
 * whole wait and report it as a generic abort.
 */
const DNS_TIMEOUT_MS = 1000;
/** Query attempts per name server, so one dropped UDP packet is not a miss. */
const DNS_TRIES = 2;
/**
 * Discord's crawler User-Agent. Embed-proxy hosts (fxtwitter, kkinstagram,
 * facebed, ...) serve OpenGraph only to a recognised bot UA and redirect
 * normal browsers to the source site; using this UA both unlocks the OG
 * payload and guarantees we observe exactly what Discord's unfurl will fetch.
 */
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';
/**
 * A plain desktop-browser User-Agent — the default for the redirect-chasing
 * methods ({@link OgClient.resolveCanonical}, {@link OgClient.resolveRedirectChain}).
 * Facebook serves the Discord crawler UA a ready-made OpenGraph card at the
 * share-link URL itself (HTTP 200, no redirect), so the crawler UA can never
 * observe the canonical permalink. A non-crawler UA instead receives Facebook's
 * 30x chain that resolves a `/share/<type>/<token>` short link to its canonical
 * `/<page>/videos/<id>/` (or `/reel/<id>`) permalink — the only form the embed
 * proxies can turn into a playable video. We follow that chain solely to read
 * the final URL; the cookieless destination page itself is discarded. The
 * Bilibili provider reuses the same chase to expand a `b23.tv` short link to
 * its canonical `bilibili.com/video/<BV|av>` URL.
 */
const RESOLVE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEFAULT_CACHE_MAX_ENTRIES = 256;
/**
 * Redirect hops to follow during a probe. Embed proxies commonly 301/302 to
 * a render host; Discord's crawler follows a few, so we match it. Bounded so
 * a redirect loop cannot stall the probe.
 */
const SAFE_MAX_REDIRECTS = 3;
/** Ceiling on a JSON API body; a single post measures a few kilobytes. */
const MAX_JSON_BYTES = 1024 * 1024;
/** Identifies the bot to a JSON API operator (see {@link OgClient.fetchJson}). */
const API_USER_AGENT = 'BotFleet-link-preview/1.0 (+https://github.com/ACaccel/BotFleet)';
/** Only the head carries OpenGraph tags; cap parsing work regardless of body size. */
const HEAD_SCAN_LIMIT = 128 * 1024;
/** Once seen in the streamed body, the rest is irrelevant — stop reading. */
const HEAD_CLOSE_TAG = '</head>';

/** Hostnames that must never be reached via a redirect (internal-only TLDs / aliases). */
const UNSAFE_HOST_SUFFIXES = ['.localhost', '.internal', '.local'] as const;

/** A label that a legacy URL parser would resolve to a numeric IPv4 (decimal/octal/hex). */
const isNumericIpLabel = (label: string): boolean => /^(0x[0-9a-f]+|\d+)$/i.test(label);

/** Refuse non-routable / internal IPv4 ranges (and the cloud metadata address). */
const isUnsafeIpv4 = (host: string): boolean => {
  const [a, b] = host.split('.').map((part) => Number.parseInt(part, 10));
  if (a === undefined || b === undefined) return true;
  if (a === 0 || a === 10 || a === 127) return true; // unspecified / private / loopback
  if (a === 169 && b === 254) return true; // link-local (incl. metadata 169.254.169.254)
  if (a === 192 && b === 168) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC 6598)
  return false;
};

/**
 * Expand a validated IPv6 literal into its 8 hextets, handling `::`
 * compression and a trailing embedded IPv4 (`::ffff:1.2.3.4`). Returns null
 * if malformed. Form-independent (works on compressed / expanded / dotted),
 * so it does not rely on the caller's URL parser normalizing the address.
 */
const ipv6Hextets = (addr: string): number[] | null => {
  let s = addr;
  const dot = s.indexOf('.');
  if (dot !== -1) {
    // Fold a trailing embedded IPv4 into two hex groups.
    const colon = s.lastIndexOf(':', dot);
    if (colon === -1) return null;
    const v4 = s
      .slice(colon + 1)
      .split('.')
      .map((p) => Number(p));
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = `${s.slice(0, colon)}:${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((g) => Number.parseInt(g, 16));
  const head = toGroups(halves[0] ?? '');
  const groups =
    halves.length === 2
      ? (() => {
          const tail = toGroups(halves[1] ?? '');
          const missing = 8 - head.length - tail.length;
          return missing < 0 ? null : [...head, ...Array<number>(missing).fill(0), ...tail];
        })()
      : head;
  if (
    groups === null ||
    groups.length !== 8 ||
    groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)
  ) {
    return null;
  }
  return groups;
};

/** Refuse non-routable / internal IPv6 (and IPv4-mapped/compatible/NAT64 forms). */
const isUnsafeIpv6 = (addr: string): boolean => {
  const h = ipv6Hextets(addr);
  if (h === null) return true; // unparseable -> refuse
  if (h.slice(0, 7).every((g) => g === 0) && (h[7] === 0 || h[7] === 1)) return true; // :: , ::1
  // IPv4-mapped (::ffff:0:0/96) or -compatible (::/96): the embedded IPv4 is
  // what the kernel actually reaches, so apply the IPv4 policy to it.
  if (h.slice(0, 5).every((g) => g === 0) && (h[5] === 0xffff || h[5] === 0)) {
    return isUnsafeIpv4(`${h[6]! >> 8}.${h[6]! & 0xff}.${h[7]! >> 8}.${h[7]! & 0xff}`);
  }
  if ((h[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((h[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if (h[0] === 0x0064 && h[1] === 0xff9b) return true; // 64:ff9b::/96 NAT64
  return false;
};

/**
 * True when a redirect target host must be refused (SSRF guard). Blocks
 * loopback / private / link-local / unspecified / CGNAT IP literals (IPv4,
 * IPv6, and IPv4-mapped IPv6), internal-only hostnames, and non-canonical
 * numeric IPv4 encodings. Public hostnames and public IPs pass. Exported for
 * unit testing.
 *
 * Note: a public hostname that *resolves* to a private IP (DNS rebinding) is
 * not caught here — full protection needs resolution-time checking; this is
 * the sole accepted residual and matches comparable OG-fetch tooling.
 */
export const isUnsafeRedirectHost = (hostname: string): boolean => {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '') // strip IPv6 brackets
    .replace(/%.*$/, '') // strip IPv6 zone id
    .replace(/\.+$/, ''); // strip the DNS root label(s): `localhost.` resolves like `localhost`
  if (host === 'localhost' || host === '') return true;
  if (UNSAFE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;

  const family = isIP(host);
  if (family === 4) return isUnsafeIpv4(host);
  if (family === 6) return isUnsafeIpv6(host);
  // family === 0: not a canonical IP literal. Refuse non-canonical numeric
  // IPv4 encodings (e.g. `2130706433`, `0x7f000001`, `010.0.0.1`, `127.1`)
  // that a legacy URL parser would resolve to an IP but `net.isIP` rejects.
  if (host.split('.').every(isNumericIpLabel)) return true;
  return false; // a public hostname
};

/**
 * axios `beforeRedirect` callback. Throws (aborting the request) when a
 * redirect hop targets a non-`http(s)` scheme or a disallowed host; the
 * thrown error surfaces on the Result's Err rail, so the provider treats
 * the host as failed and falls through to the next candidate.
 */
const assertSafeRedirect = (options: {
  readonly protocol?: string;
  readonly hostname?: string;
  readonly host?: string;
}): void => {
  const protocol = (options.protocol ?? '').toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`link-preview: refusing redirect to non-http(s) scheme "${protocol}"`);
  }
  const hostname = options.hostname ?? options.host ?? '';
  if (isUnsafeRedirectHost(hostname)) {
    throw new Error(`link-preview: refusing redirect to disallowed host "${hostname}"`);
  }
};

/**
 * The final URL after any redirects (the http adapter sets `responseUrl`
 * even when no redirect occurred). Used to label a media response; falls
 * back to the requested URL when the adapter does not expose it (e.g. a
 * mocked client in tests).
 */
const readFinalUrl = (response: { readonly request?: unknown }, requested: string): string => {
  const request = response.request as
    | { res?: { responseUrl?: unknown }; responseUrl?: unknown }
    | undefined;
  const viaRes = request?.res?.responseUrl;
  if (typeof viaRes === 'string' && viaRes.length > 0) return viaRes;
  const viaRequest = request?.responseUrl;
  if (typeof viaRequest === 'string' && viaRequest.length > 0) return viaRequest;
  return requested;
};

/**
 * Abandon a response stream we will not read (a media body classified from
 * its Content-Type). A late socket error on a destroyed stream must not be
 * allowed to crash the process, so a no-op error listener is attached first.
 */
const discardStream = (stream: Readable): void => {
  stream.on('error', () => undefined);
  stream.destroy();
};

/** A redirect-target path/URL ending in a directly-embeddable media file. */
const VIDEO_FILE_RE = /\.(?:mp4|m4v|mov|webm)(?:$|[?#])/i;
const IMAGE_FILE_RE = /\.(?:jpe?g|png|gif|webp|bmp)(?:$|[?#])/i;

/** Reconstruct a redirect hop's target URL from a `beforeRedirect` options bag. */
const redirectTargetUrl = (options: {
  readonly protocol?: string;
  readonly hostname?: string;
  readonly host?: string;
  readonly path?: string;
  readonly pathname?: string;
}): string => {
  const protocol = options.protocol ?? 'https:';
  const host = options.hostname ?? options.host ?? '';
  const path = options.path ?? options.pathname ?? '';
  return `${protocol}//${host}${path}`;
};

/**
 * Classify a recorded redirect chain by the first hop that targets a media
 * file. Some proxies (e.g. `kkinstagram`) 3xx the bot UA straight to a
 * `*.mp4` on a CDN; that redirect is itself proof Discord will embed a video.
 * Because DISCORD — not this bot — performs the unfurl, the evidence is the
 * redirect target, not our ability to reach the CDN (whose datacenter-IP
 * peering may time out for our host yet be open to Discord). So when the body
 * fetch fails, a media-file redirect still counts as a valid preview rather
 * than a dropped host. Returns the media meta, or undefined when no hop looks
 * like media (the failure then propagates normally).
 */
const classifyRedirectMedia = (targets: readonly string[]): OpenGraphMeta | undefined => {
  const video = targets.find((t) => VIDEO_FILE_RE.test(t));
  if (video !== undefined) return { images: [], video, url: video, finalUrl: video };
  const image = targets.find((t) => IMAGE_FILE_RE.test(t));
  if (image !== undefined) return { images: [image], url: image, finalUrl: image };
  return undefined;
};

/**
 * Destroy a response stream left attached to a rejected request (axios
 * exposes the error response's body stream on `error.response.data`), so a
 * failed probe never leaks an open socket.
 */
const destroyResponseStream = (error: unknown): void => {
  const data = (error as { response?: { data?: unknown } } | undefined)?.response?.data;
  if (
    data !== null &&
    typeof data === 'object' &&
    typeof (data as { destroy?: unknown }).destroy === 'function'
  ) {
    discardStream(data as Readable);
  }
};

/** Image-bearing meta keys, in preference order, collected into `images`. */
const IMAGE_KEYS = ['og:image', 'og:image:secure_url', 'og:image:url', 'twitter:image'] as const;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  '#x27': "'",
  nbsp: ' ',
};

/** Decode the small set of HTML entities that appear in OpenGraph content. */
const decodeEntities = (value: string): string =>
  value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    const named = NAMED_ENTITIES[body.toLowerCase()];
    if (named !== undefined) return named;
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return match;
  });

const META_TAG_RE = /<meta\b[^>]*>/gi;

/**
 * Extract an attribute value (double-quoted, single-quoted, or unquoted)
 * from a tag string. Some embed proxies emit unquoted OpenGraph attributes
 * (e.g. vxbilibili: `property=og:video`, `content=http://host/img.jpg`); a
 * quoted-only matcher would skip the tag entirely and lose its preview. An
 * unquoted value runs to the next whitespace or `>` (so it keeps a URL's
 * `:` / `/`), matching how a lenient HTML parser reads the attribute.
 */
const attr = (tag: string, name: string): string | undefined => {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = re.exec(tag);
  if (m === null) return undefined;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
};

/**
 * Parse the OpenGraph / Twitter-card tags from an HTML string. Pure and
 * exported for unit tests. `og:*` wins over `twitter:*` for the same
 * field; the first occurrence of each tag wins.
 */
export const parseOpenGraph = (html: string): OpenGraphMeta => {
  const headEnd = html.indexOf('</head>');
  const scanned = (headEnd >= 0 ? html.slice(0, headEnd) : html).slice(0, HEAD_SCAN_LIMIT);

  const values = new Map<string, string>();
  const imageKeys = new Set<string>(IMAGE_KEYS);
  // All distinct image URLs in document order. Used only for "has an image?"
  // (validation) and the first image (Bahamut card), so exact gallery
  // de-duplication of secure_url/url variants is unnecessary.
  const images: string[] = [];
  const imageSeen = new Set<string>();

  for (const [tag] of scanned.matchAll(META_TAG_RE)) {
    const key = (attr(tag, 'property') ?? attr(tag, 'name'))?.toLowerCase();
    if (key === undefined) continue;
    const content = attr(tag, 'content');
    if (content === undefined || content.length === 0) continue;
    // First occurrence wins for scalars — keeps the canonical tag.
    if (!values.has(key)) values.set(key, content);
    if (imageKeys.has(key) && !imageSeen.has(content)) {
      imageSeen.add(content);
      images.push(content);
    }
  }

  const pick = (...keys: readonly string[]): string | undefined => {
    for (const key of keys) {
      const found = values.get(key);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  return {
    title: pick('og:title', 'twitter:title'),
    description: pick('og:description', 'twitter:description'),
    images,
    video: pick('og:video:secure_url', 'og:video:url', 'og:video'),
    url: pick('og:url'),
    siteName: pick('og:site_name'),
    ...(pick('author') === undefined ? {} : { authorName: pick('author') }),
    ...(pick('article:author') === undefined ? {} : { authorUrl: pick('article:author') }),
  };
};

/**
 * The slice of a `dns.promises.Resolver` the bounded lookup relies on —
 * the plain-address overloads only, so a test can supply a fake without
 * reproducing the resolver's TTL-record overloads.
 */
export interface AddressResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

/** Whether a `dns.lookup` family option asks for records of `target`. */
const wantsFamily = (family: LookupOptions['family'], target: 4 | 6): boolean =>
  family === undefined ||
  family === 0 ||
  family === target ||
  family === (target === 4 ? 'IPv4' : 'IPv6');

/**
 * The error a failed lookup reports. A timeout wins over any other reason
 * because it is the actionable one (a dead name server) and it maps to
 * `LINK_PREVIEW_TIMEOUT`; a non-`Error` rejection or an empty answer is
 * reported as `ENOTFOUND`, the code `getaddrinfo` would have used.
 */
const lookupFailure = (
  outcomes: readonly PromiseSettledResult<unknown>[],
  hostname: string,
): NodeJS.ErrnoException => {
  const reasons = outcomes.flatMap((o) => (o.status === 'rejected' ? [o.reason as unknown] : []));
  const errors = reasons.filter((r): r is NodeJS.ErrnoException => r instanceof Error);
  const timeout = errors.find((e) => e.code === 'ETIMEOUT');
  const chosen = timeout ?? errors[0];
  if (chosen !== undefined) return chosen;
  return Object.assign(new Error(`link-preview: no address for "${hostname}"`), {
    code: 'ENOTFOUND',
    hostname,
  });
};

/**
 * A `net.connect`-compatible `lookup` that resolves through `resolver`
 * (c-ares: asynchronous, per-query timeout, no threadpool) instead of
 * `getaddrinfo`. Honours the `family` filter and the `all` flag the socket
 * layer passes (Node's happy-eyeballs path asks for `all` and both
 * families). `/etc/hosts` is not consulted, which is fine for the public
 * proxy and source hosts this client ever probes. Exported for unit tests.
 */
export const createBoundedLookup =
  (resolver: AddressResolver): LookupFunction =>
  (hostname, options, callback) => {
    const query = async (target: 4 | 6): Promise<LookupAddress[]> => {
      if (!wantsFamily(options.family, target)) return [];
      const records =
        target === 4 ? await resolver.resolve4(hostname) : await resolver.resolve6(hostname);
      return records.map((address) => ({ address, family: target }));
    };
    void Promise.allSettled([query(4), query(6)]).then((outcomes) => {
      const addresses = outcomes.flatMap((o) => (o.status === 'fulfilled' ? o.value : []));
      const first = addresses[0];
      if (first === undefined) {
        callback(lookupFailure(outcomes, hostname), []);
      } else if (options.all === true) {
        callback(null, addresses);
      } else {
        callback(null, first.address, first.family);
      }
    });
  };

interface CacheEntry {
  readonly value: OpenGraphMeta;
  readonly expiresAt: number;
}

export class OgClient {
  private readonly maxContentLength: number;
  private readonly userAgent: string;
  private readonly cacheTtlMs: number;
  private readonly cacheMaxEntries: number;
  private readonly now: () => number;
  /** Insertion-ordered (Map preserves it) cache of successful fetches by URL. */
  private readonly cache = new Map<string, CacheEntry>();
  /** Per-protocol agents whose sockets resolve names via the bounded lookup. */
  private readonly httpAgent: http.Agent;
  private readonly httpsAgent: https.Agent;

  public constructor(options: OgClientOptions = {}) {
    this.maxContentLength = options.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.cacheTtlMs = options.cacheTtlMs ?? 0;
    this.cacheMaxEntries = options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
    const lookup = createBoundedLookup(
      new dnsPromises.Resolver({ timeout: DNS_TIMEOUT_MS, tries: DNS_TRIES }),
    );
    this.httpAgent = new http.Agent({ keepAlive: true, lookup });
    this.httpsAgent = new https.Agent({ keepAlive: true, lookup });
  }

  /**
   * Fetch `url` and parse its OpenGraph metadata. `provider` is the
   * source name used to tag any error. Returns `Err` on transport / HTTP
   * failure or when the page carries no usable OpenGraph tags. The result
   * carries `finalUrl`, the URL the response was served from after any
   * redirects, so the caller can tell where the metadata really came from.
   * Only successful results are cached (a transient outage self-heals on
   * the next call).
   */
  public async fetch(
    url: string,
    provider: string,
    timeoutMs: number,
  ): Promise<Result<OpenGraphMeta, LinkPreviewFailure>> {
    const cached = this.readCache(url);
    if (cached !== undefined) return ok(cached);

    const redirectTargets: string[] = [];
    try {
      const meta = await this.fetchFresh(url, timeoutMs, redirectTargets);
      this.writeCache(url, meta);
      return ok(meta);
    } catch (e: unknown) {
      destroyResponseStream(e);
      // A proxy may 3xx straight to a media file on a CDN our host cannot
      // reach (but Discord can); the redirect target alone proves the media,
      // so treat it as a hit rather than a failed host.
      const media = classifyRedirectMedia(redirectTargets);
      if (media !== undefined) {
        this.writeCache(url, media);
        return ok(media);
      }
      return err(translateLinkPreviewError(provider, e));
    }
  }

  /**
   * GET `url` from a JSON API and return the parsed body, unvalidated — the
   * caller owns the schema. Used by the X provider to read a post from an
   * operator-configured FxTwitter-compatible API.
   *
   * Same contract as {@link fetch}: `url` is built from an operator-supplied
   * base and an id the caller already matched, every redirect hop is
   * screened by {@link assertSafeRedirect}, names resolve through the
   * bounded lookup, and the body is capped at {@link MAX_JSON_BYTES}. The
   * request identifies the bot rather than impersonating Discord's crawler:
   * an API needs no crawler UA, and a descriptive one lets the operator
   * attribute the traffic. Responses are not cached.
   */
  public async fetchJson(
    url: string,
    provider: string,
    timeoutMs: number,
  ): Promise<Result<unknown, LinkPreviewFailure>> {
    try {
      const response = await axios.get<unknown>(url, {
        responseType: 'json',
        timeout: timeoutMs,
        httpAgent: this.httpAgent,
        httpsAgent: this.httpsAgent,
        maxRedirects: SAFE_MAX_REDIRECTS,
        maxContentLength: MAX_JSON_BYTES,
        beforeRedirect: (options) => assertSafeRedirect(options),
        headers: { 'User-Agent': API_USER_AGENT, Accept: 'application/json' },
      });
      return ok(response.data);
    } catch (e: unknown) {
      return err(translateLinkPreviewError(provider, e));
    }
  }

  /**
   * Follow `url`'s redirect chain (with a plain browser UA) and return the
   * final URL, without reading the body. Used to expand an opaque short /
   * share link into the canonical permalink an embed proxy can actually
   * preview — by the Facebook provider for a `/share/<type>/<token>` link and
   * by the Bilibili provider for a `b23.tv` short link.
   *
   * Contract mirrors {@link fetch}: the caller MUST have matched `url`
   * against its own host allow-list first (so the initial host is never
   * arbitrary user input), and every redirect hop is screened by the same
   * {@link assertSafeRedirect} SSRF guard. The body stream is discarded
   * immediately — only the post-redirect URL is of interest — so a heavy or
   * login-gated destination page costs nothing to read.
   *
   * @param provider Source name used to tag any error on the Err rail
   *   (defaults to `'facebook'`, the original caller).
   */
  public async resolveCanonical(
    url: string,
    timeoutMs: number,
    provider: string = 'facebook',
  ): Promise<Result<string, LinkPreviewFailure>> {
    try {
      return ok(await this.chaseRedirects(url, timeoutMs, RESOLVE_USER_AGENT, []));
    } catch (e: unknown) {
      destroyResponseStream(e);
      return err(translateLinkPreviewError(provider, e));
    }
  }

  /**
   * Follow `url`'s redirect chain and return EVERY hop's target URL, in order
   * (an empty array when the response did not redirect). The body is never
   * read.
   *
   * Why the whole chain rather than the landing URL {@link resolveCanonical}
   * returns: a source may mint a single-use token into its short link and
   * reject that token on the follow-up request, bouncing the chase to a
   * generic error page. The permalink then exists only as an INTERMEDIATE hop,
   * and the landing URL carries nothing a proxy can preview. Scanning every
   * hop also absorbs a legacy-domain 301 that precedes the real expansion, so
   * a short link needing two hops costs the caller nothing extra.
   *
   * `userAgent` overrides the default browser UA because redirect behaviour is
   * routinely UA-discriminated: a source may answer a full desktop-browser UA
   * with a client-side-routed application shell (HTTP 200, no `Location` at
   * all) that resolves the link in the browser, where no server-side chase can
   * observe it, while a plainer UA still receives the 30x. The caller picks
   * the UA its source is known to redirect for.
   *
   * Contract mirrors {@link fetch}: the caller MUST have matched `url` against
   * its own host allow-list first (so the initial host is never arbitrary user
   * input), and every hop is screened by the same {@link assertSafeRedirect}
   * SSRF guard. A transport failure after at least one hop was recorded still
   * returns `Ok` — the recorded hops already identify the permalink, the same
   * salvage {@link fetch} performs for a media-file redirect — so only a
   * failure with no hops at all lands on the Err rail.
   */
  public async resolveRedirectChain(
    url: string,
    timeoutMs: number,
    provider: string,
    userAgent: string = RESOLVE_USER_AGENT,
  ): Promise<Result<readonly string[], LinkPreviewFailure>> {
    const hops: string[] = [];
    try {
      await this.chaseRedirects(url, timeoutMs, userAgent, hops);
      return ok(hops);
    } catch (e: unknown) {
      destroyResponseStream(e);
      if (hops.length > 0) return ok(hops);
      return err(translateLinkPreviewError(provider, e));
    }
  }

  /**
   * The redirect chase both public resolvers are built on: one GET with the
   * given UA, at most {@link SAFE_MAX_REDIRECTS} hops (each screened by the
   * SSRF guard and appended to `hops`), the destination body discarded
   * unread, and the post-redirect URL returned. Throws the transport error so
   * each caller can apply its own salvage and Err mapping.
   */
  private async chaseRedirects(
    url: string,
    timeoutMs: number,
    userAgent: string,
    hops: string[],
  ): Promise<string> {
    const response = await axios.get<Readable>(url, {
      responseType: 'stream',
      timeout: timeoutMs,
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent,
      maxRedirects: SAFE_MAX_REDIRECTS,
      beforeRedirect: (options) => {
        assertSafeRedirect(options);
        hops.push(redirectTargetUrl(options));
      },
      // A non-crawler UA by default: the source only emits the short ->
      // canonical redirect for a browser-like UA (the crawler UA gets a 200
      // page).
      headers: { 'User-Agent': userAgent, Accept: 'text/html' },
    });
    discardStream(response.data);
    return readFinalUrl(response, url);
  }

  /**
   * Perform the network probe and classify the response. A `video/*` /
   * `image/*` Content-Type is itself the preview (Discord embeds the file
   * its crawler is redirected to), so no body is downloaded; anything else
   * is read as HTML and its `<head>` parsed for OpenGraph tags. Every
   * redirect hop is appended to `redirectTargets` so the caller can still
   * recognise a media-file redirect when the body fetch itself fails.
   */
  private async fetchFresh(
    url: string,
    timeoutMs: number,
    redirectTargets: string[],
  ): Promise<OpenGraphMeta> {
    const response = await axios.get<Readable>(url, {
      // Stream so a media body is never pulled and a large HTML page is read
      // only up to its <head>; axios does not enforce maxContentLength on a
      // stream, so the read is bounded explicitly in `readHead`.
      responseType: 'stream',
      timeout: timeoutMs,
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent,
      // Follow a few redirects (proxies redirect to a render / CDN host, as
      // Discord does), but the SSRF guard refuses internal hops. Record each
      // hop's target for media-file recognition on failure.
      maxRedirects: SAFE_MAX_REDIRECTS,
      beforeRedirect: (options) => {
        assertSafeRedirect(options);
        redirectTargets.push(redirectTargetUrl(options));
      },
      headers: { 'User-Agent': this.userAgent, Accept: 'text/html' },
    });

    const stream = response.data;
    const contentType = String(
      (response.headers as Record<string, unknown>)['content-type'] ?? '',
    ).toLowerCase();
    const finalUrl = readFinalUrl(response, url);

    if (contentType.startsWith('video/')) {
      discardStream(stream);
      return { images: [], video: finalUrl, url: finalUrl, finalUrl };
    }
    if (contentType.startsWith('image/')) {
      discardStream(stream);
      return { images: [finalUrl], url: finalUrl, finalUrl };
    }
    const html = await this.readHead(stream, timeoutMs);
    return { ...parseOpenGraph(html), finalUrl };
  }

  /**
   * Read a streamed HTML body only as far as the `</head>` close (or the
   * configured byte cap), then stop and destroy the stream. A read deadline
   * guards a body that trickles slowly after the headers arrive. Resolves
   * with whatever was read — an empty / partial head simply yields no usable
   * tags, which the caller treats as "no media".
   */
  private readHead(stream: Readable, timeoutMs: number): Promise<string> {
    const byteCap = this.maxContentLength;
    return new Promise<string>((resolve, reject) => {
      const decoder = new StringDecoder('utf8');
      let html = '';
      let bytes = 0;
      let settled = false;
      const conclude = (action: () => void): void => {
        if (settled) return;
        settled = true;
        stream.destroy();
        action();
      };
      const finish = (): void => conclude(() => resolve(html + decoder.end()));
      const fail = (e: Error): void => conclude(() => reject(e));

      // Read deadline: a body that trickles slowly after the headers arrive
      // (axios `timeout` only covers time-to-headers) must not hold the probe
      // open. `conclude` is idempotent, so the timer simply no-ops once the
      // stream has already settled; `unref` keeps it from holding the event
      // loop open.
      setTimeout(finish, timeoutMs).unref();
      stream.on('data', (chunk: Buffer) => {
        html += decoder.write(chunk);
        bytes += chunk.length;
        // Stop as soon as the <head> closes or the cap is hit — never buffer
        // a multi-MB body (e.g. the ~900 KB instagram.com fallback page).
        if (bytes >= byteCap || html.includes(HEAD_CLOSE_TAG)) finish();
      });
      stream.once('end', finish);
      stream.once('error', fail);
    });
  }

  private readCache(url: string): OpenGraphMeta | undefined {
    if (this.cacheTtlMs <= 0) return undefined;
    const entry = this.cache.get(url);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(url);
      return undefined;
    }
    return entry.value;
  }

  private writeCache(url: string, value: OpenGraphMeta): void {
    if (this.cacheTtlMs <= 0) return;
    // Evict the oldest entry (first inserted) when at capacity.
    if (this.cache.size >= this.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(url, { value, expiresAt: this.now() + this.cacheTtlMs });
  }
}
