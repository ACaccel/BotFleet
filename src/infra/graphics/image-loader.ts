/**
 * Remote images for Canvas renderers: custom emoji, sticker and avatar
 * pictures from the Discord CDN.
 *
 * A picture is decoration, so every failure (a host outside the allowlist,
 * a timeout, an HTTP error, an undecodable or oversized body) resolves to `null`
 * and the renderer draws its text or placeholder instead. Downloads go through
 * the shared bounded HTTP client without redirects, under one overall deadline
 * and a size cap, at most `concurrency` at a time; decoded images are kept in a
 * small in-process LRU cache, and concurrent requests for one URL share one
 * download. Failures are not cached, so a transient CDN error is retried next
 * time, and are logged at most once a minute per host with how many were
 * suppressed.
 */
import { loadImage, type Image } from 'canvas';

import { ops, type Logger } from '../../core/logger';
import { boundedHttp } from '../http';

export interface RemoteImageLoader {
  /** The decoded picture, or `null` when it cannot be downloaded or decoded. */
  load(url: string): Promise<Image | null>;
}

interface ImageLoaderOptions {
  /** Downloads the bytes; defaults to the bounded HTTP client. */
  readonly fetchBytes?: (url: string, timeoutMs: number) => Promise<Buffer>;
  readonly decode?: (bytes: Buffer) => Promise<Image>;
  readonly timeoutMs?: number;
  readonly concurrency?: number;
  readonly cacheSize?: number;
  /** Hosts a URL may point at; anything else resolves to `null` without a request. */
  readonly allowedHosts?: readonly string[];
  /** Receives rate-limited warnings about failed downloads. */
  readonly logger?: Logger;
  /** Clock for the log rate limit. */
  readonly now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_CACHE_SIZE = 256;
/** Emoji, stickers and avatars are small; anything larger is not one. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** Emoji and stickers are at most a few hundred pixels; a larger picture is not one. */
const MAX_IMAGE_SIDE = 1024;
const DISCORD_CDN_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'] as const;
const LOG_INTERVAL_MS = 60_000;

const fetchWithBoundedHttp = async (url: string, timeoutMs: number): Promise<Buffer> => {
  const response = await boundedHttp.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    timeout: timeoutMs,
    // `timeout` covers the response wait; the signal bounds the whole download.
    signal: AbortSignal.timeout(timeoutMs),
    maxContentLength: MAX_IMAGE_BYTES,
    maxRedirects: 0,
  });
  return Buffer.from(response.data);
};

/** A short failure label for the log: an HTTP status, a socket code or the error name. */
const failureCode = (error: unknown): string => {
  if (typeof error !== 'object' || error === null) return 'unknown';
  const fields = error as { response?: { status?: unknown }; code?: unknown; name?: unknown };
  if (typeof fields.response?.status === 'number') return `http-${fields.response.status}`;
  if (typeof fields.code === 'string') return fields.code;
  return typeof fields.name === 'string' ? fields.name : 'unknown';
};

class ImageTooLarge extends Error {
  public override readonly name = 'ImageTooLarge';
}

const hostAllowed = (url: string, hosts: readonly string[]): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && hosts.includes(parsed.hostname);
  } catch {
    return false;
  }
};

export const createImageLoader = (options: ImageLoaderOptions = {}): RemoteImageLoader => {
  const fetchBytes = options.fetchBytes ?? fetchWithBoundedHttp;
  const decode = options.decode ?? loadImage;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const cacheSize = Math.max(0, options.cacheSize ?? DEFAULT_CACHE_SIZE);
  const hosts = options.allowedHosts ?? DISCORD_CDN_HOSTS;
  const now = options.now ?? Date.now;
  const lastLogged = new Map<string, { at: number; suppressed: number }>();
  const report = (url: string, error: unknown): void => {
    if (options.logger === undefined) return;
    const host = new URL(url).hostname;
    const entry = lastLogged.get(host);
    if (entry !== undefined && now() - entry.at < LOG_INTERVAL_MS) {
      entry.suppressed += 1;
      return;
    }
    options.logger.warn(
      ops.graphics.imageDownloadFailed(host, failureCode(error), entry?.suppressed ?? 0),
    );
    lastLogged.set(host, { at: now(), suppressed: 0 });
  };
  const cache = new Map<string, Image>();
  const inFlight = new Map<string, Promise<Image | null>>();
  const waiting: (() => void)[] = [];
  let active = 0;

  const acquire = async (): Promise<void> => {
    if (active < concurrency) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next === undefined) active -= 1;
    else next();
  };
  const remember = (url: string, image: Image): void => {
    if (cacheSize === 0) return;
    cache.delete(url);
    cache.set(url, image);
    if (cache.size > cacheSize) {
      const oldest = cache.keys().next();
      if (oldest.done !== true) cache.delete(oldest.value);
    }
  };
  const download = async (url: string): Promise<Image | null> => {
    await acquire();
    try {
      const image = await decode(await fetchBytes(url, timeoutMs));
      if (!(image.width > 0 && image.height > 0)) return null;
      if (image.width > MAX_IMAGE_SIDE || image.height > MAX_IMAGE_SIDE)
        throw new ImageTooLarge(`${image.width}x${image.height}`);
      remember(url, image);
      return image;
    } catch (error: unknown) {
      report(url, error);
      return null;
    } finally {
      release();
    }
  };

  return {
    load: async (url) => {
      if (!hostAllowed(url, hosts)) return null;
      const cached = cache.get(url);
      if (cached !== undefined) {
        remember(url, cached);
        return cached;
      }
      const pending = inFlight.get(url);
      if (pending !== undefined) return pending;
      const request = download(url).finally(() => inFlight.delete(url));
      inFlight.set(url, request);
      return request;
    },
  };
};
