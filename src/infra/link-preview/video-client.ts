import { promises as dnsPromises } from 'node:dns';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

import axios from 'axios';

import { createBoundedLookup, isUnsafeRedirectHost, type AddressResolver } from './og-client';

export interface PreviewVideo {
  readonly data: Buffer;
  readonly name: string;
}

/** Validate the addresses actually used by the socket, including redirect hosts. */
export const createVideoLookup = (resolver: AddressResolver): LookupFunction => {
  const check = (addresses: string[]): string[] => {
    if (addresses.some(isUnsafeRedirectHost)) throw new Error('Unsafe video address');
    return addresses;
  };
  return createBoundedLookup({
    resolve4: async (hostname) => check(await resolver.resolve4(hostname)),
    resolve6: async (hostname) => check(await resolver.resolve6(hostname)),
  });
};

const agent = new https.Agent({
  keepAlive: true,
  lookup: createVideoLookup(new dnsPromises.Resolver({ timeout: 1000, tries: 2 })),
});
const MAX_DOWNLOADS = 2;
const HARD_MAX_BYTES = 25 * 1024 * 1024;
let activeDownloads = 0;

const assertVideoUrl = (input: string): void => {
  const url = new URL(input);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.port !== '' && url.port !== '443') ||
    isUnsafeRedirectHost(url.hostname)
  )
    throw new Error('Unsafe video URL');
};

/**
 * Download only supported video responses. Saturation falls back immediately,
 * so incoming messages cannot build an unbounded download queue.
 */
export const downloadPreviewVideo = async (
  url: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<PreviewVideo | null> => {
  if (
    activeDownloads >= MAX_DOWNLOADS ||
    !Number.isInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > HARD_MAX_BYTES ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 60_000
  )
    return null;
  let stream: Readable | undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  activeDownloads += 1;
  try {
    assertVideoUrl(url);
    const response = await axios.get<Readable>(url, {
      responseType: 'stream',
      timeout: timeoutMs,
      signal: controller.signal,
      httpsAgent: agent,
      proxy: false,
      maxRedirects: 5,
      beforeRedirect: (options) => {
        if (options.auth) throw new Error('Unsafe video redirect credentials');
        assertVideoUrl(
          `https://${options.hostname ?? ''}${options.port ? `:${options.port}` : ''}/`,
        );
        if (options.protocol !== 'https:') throw new Error('Unsafe video redirect');
      },
      headers: { Accept: 'video/mp4, video/quicktime', 'User-Agent': 'Discordbot/2.0' },
    });
    stream = response.data;
    const contentType = String(response.headers['content-type'] ?? '')
      .split(';')[0]
      ?.trim()
      .toLowerCase();
    const name =
      contentType === 'video/mp4'
        ? 'facebook.mp4'
        : contentType === 'video/quicktime'
          ? 'facebook.mov'
          : undefined;
    if (name === undefined || Number(response.headers['content-length']) > maxBytes) return null;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > maxBytes) return null;
      chunks.push(bytes);
    }
    return size > 0 ? { data: Buffer.concat(chunks, size), name } : null;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const body: unknown = error.response?.data;
      if (body instanceof Readable) stream = body;
    }
    return null;
  } finally {
    clearTimeout(timer);
    if (stream !== undefined) {
      stream.on('error', () => undefined);
      stream.destroy();
    }
    controller.abort();
    activeDownloads -= 1;
  }
};
