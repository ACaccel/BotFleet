/**
 * Bounded HTTP access for gallery sources: metadata reads from a source's
 * fixed host and page-image downloads from whatever CDN host the metadata
 * names.
 *
 * Image hosts come from upstream HTML or JSON, so they are untrusted: every
 * request is HTTPS on the default port without credentials, every redirect
 * hop is rechecked, and the socket resolves names through a lookup that
 * refuses private, loopback and link-local addresses, which also closes the
 * DNS-rebinding gap a hostname check alone leaves. Each request has an
 * overall deadline and a body cap.
 */
import { promises as dnsPromises } from 'node:dns';
import https from 'node:https';

import axios, { type AxiosRequestConfig } from 'axios';

import { err, ok, type Result } from '../../../core/result';
import { translateLinkPreviewError } from '../error-translator';
import { isUnsafeRedirectHost } from '../og-client';
import type { LinkPreviewFailure } from '../types';
import { createVideoLookup } from '../video-client';

/** Identifies the bot to upstreams rather than impersonating a browser. */
const USER_AGENT = 'Pleiades-link-preview/1.0 (+https://github.com/ACaccel/pleiades-fleet)';
const MAX_REDIRECTS = 3;
/** Ceiling on a metadata body; a long wnacg index page is well under this. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** Image types Discord renders inline in an embed, keyed to a file extension. */
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** HTTP statuses meaning the URL itself is stale (expired signature, removed page). */
const GONE_STATUSES: ReadonlySet<number> = new Set([403, 404, 410]);

export interface GalleryImage {
  readonly data: Buffer;
  /** File extension matching the served content type, without the dot. */
  readonly extension: string;
}

/**
 * `gone` means the URL will not work again and the gallery's metadata
 * should be refetched; `failed` covers transport faults, oversize bodies and
 * unsupported content types, which a retry of the same URL may survive.
 */
export type GalleryImageOutcome =
  | { readonly ok: true; readonly image: GalleryImage }
  | { readonly ok: false; readonly reason: 'gone' | 'failed' };

/** Metadata reads answer `Ok(null)` for a 404, so a removed gallery is not a fault. */
export interface GalleryHttp {
  getText(
    url: string,
    provider: string,
    timeoutMs: number,
  ): Promise<Result<string | null, LinkPreviewFailure>>;
  getJson(
    url: string,
    provider: string,
    timeoutMs: number,
  ): Promise<Result<unknown, LinkPreviewFailure>>;
  getImage(url: string, maxBytes: number, timeoutMs: number): Promise<GalleryImageOutcome>;
}

/** Refuse anything but credential-free HTTPS on the default port to a public host. */
export const isSafeGalleryUrl = (input: string): boolean => {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    (url.port === '' || url.port === '443') &&
    !isUnsafeRedirectHost(url.hostname)
  );
};

const assertSafeUrl = (input: string): void => {
  if (!isSafeGalleryUrl(input)) throw new Error('gallery: refusing unsafe URL');
};

const statusOf = (error: unknown): number | undefined => {
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === 'number' ? status : undefined;
};

export const createGalleryHttp = (): GalleryHttp => {
  const agent = new https.Agent({
    keepAlive: true,
    lookup: createVideoLookup(new dnsPromises.Resolver({ timeout: 1000, tries: 2 })),
  });

  const request = async <T>(
    url: string,
    timeoutMs: number,
    config: AxiosRequestConfig,
  ): Promise<{ data: T; contentType: string }> => {
    assertSafeUrl(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    try {
      const response = await axios.get<T>(url, {
        ...config,
        timeout: timeoutMs,
        signal: controller.signal,
        httpsAgent: agent,
        proxy: false,
        maxRedirects: MAX_REDIRECTS,
        beforeRedirect: (options) => {
          if (options.auth) throw new Error('gallery: refusing redirect credentials');
          if (options.protocol !== 'https:') throw new Error('gallery: refusing redirect');
          assertSafeUrl(
            `https://${options.hostname ?? ''}${options.port ? `:${options.port}` : ''}/`,
          );
        },
        headers: { 'User-Agent': USER_AGENT, ...config.headers },
      });
      const contentType = String(response.headers['content-type'] ?? '')
        .split(';')[0]
        ?.trim()
        .toLowerCase();
      return { data: response.data, contentType: contentType ?? '' };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    getText: async (url, provider, timeoutMs) => {
      try {
        const { data } = await request<string>(url, timeoutMs, {
          responseType: 'text',
          maxContentLength: MAX_TEXT_BYTES,
          headers: { Accept: 'text/html, application/javascript, */*' },
        });
        return ok(data);
      } catch (error: unknown) {
        if (statusOf(error) === 404) return ok(null);
        return err(translateLinkPreviewError(provider, error));
      }
    },
    getJson: async (url, provider, timeoutMs) => {
      try {
        const { data } = await request<unknown>(url, timeoutMs, {
          responseType: 'json',
          maxContentLength: MAX_TEXT_BYTES,
          headers: { Accept: 'application/json' },
        });
        return ok(data);
      } catch (error: unknown) {
        if (statusOf(error) === 404) return ok(null);
        return err(translateLinkPreviewError(provider, error));
      }
    },
    getImage: async (url, maxBytes, timeoutMs) => {
      try {
        const { data, contentType } = await request<ArrayBuffer>(url, timeoutMs, {
          responseType: 'arraybuffer',
          maxContentLength: maxBytes,
          headers: { Accept: 'image/webp, image/png, image/jpeg, image/gif' },
        });
        const extension = IMAGE_EXTENSIONS[contentType];
        const bytes = Buffer.from(data);
        if (extension === undefined || bytes.length === 0 || bytes.length > maxBytes) {
          return { ok: false, reason: 'failed' };
        }
        return { ok: true, image: { data: bytes, extension } };
      } catch (error: unknown) {
        const status = statusOf(error);
        return {
          ok: false,
          reason: status !== undefined && GONE_STATUSES.has(status) ? 'gone' : 'failed',
        };
      }
    },
  };
};
