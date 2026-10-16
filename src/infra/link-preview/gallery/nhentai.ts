/**
 * nhentai source, read through the site's public v2 JSON API.
 *
 * Page paths are relative to the image servers the API's `/cdn` endpoint
 * lists. That list is cached for an hour, and each page gets every server
 * as a candidate, starting at a different one per page to spread load.
 */
import { z } from 'zod';

import { err, ok, type Result } from '../../../core/result';
import { invalidResponseError } from '../error-translator';
import type { Gallery, GalleryTagGroup, LinkPreviewFailure } from '../types';
import { isSafeGalleryUrl, type GalleryHttp } from './http';
import { GALLERY_ID_PATTERN, type GalleryRef, type GallerySource } from './source';

const PROVIDER_NAME = 'nhentai';
const API_BASE = 'https://nhentai.net/api/v2';
const HOSTS: ReadonlySet<string> = new Set(['nhentai.net', 'www.nhentai.net']);
/** `/g/<id>/` with an optional `<page>/` reader suffix. */
const PATH_RE = /^\/g\/(\d{1,9})(?:\/(\d{1,4}))?\/?$/;
const CDN_TTL_MS = 60 * 60 * 1000;
/** Tag groups shown, in display order; the rest (e.g. `category`) add little. */
const TAG_ORDER = ['parody', 'character', 'artist', 'group', 'language', 'tag'] as const;

const gallerySchema = z.object({
  id: z.number().int().positive(),
  title: z.object({
    english: z.string().nullish(),
    japanese: z.string().nullish(),
    pretty: z.string().nullish(),
  }),
  upload_date: z.number().int().nonnegative().optional(),
  num_favorites: z.number().int().nonnegative().optional(),
  tags: z.array(z.object({ type: z.string(), name: z.string() })).default([]),
  pages: z.array(z.object({ path: z.string().min(1) })),
});

const cdnSchema = z.object({ image_servers: z.array(z.string()).nonempty() });

const firstText = (...values: ReadonlyArray<string | null | undefined>): string | undefined =>
  values.map((value) => value?.trim()).find((value): value is string => !!value);

const groupTags = (tags: ReadonlyArray<{ type: string; name: string }>): GalleryTagGroup[] =>
  TAG_ORDER.map((type) => ({
    type,
    names: tags.filter((tag) => tag.type === type).map((tag) => tag.name),
  })).filter((group) => group.names.length > 0);

/** `servers` rotated so page `index` starts at its own server. */
const rotated = (servers: readonly string[], index: number): string[] => {
  const start = index % servers.length;
  return [...servers.slice(start), ...servers.slice(0, start)];
};

export const createNhentaiSource = (
  http: GalleryHttp,
  now: () => number = Date.now,
): GallerySource => {
  let cdn: { servers: readonly string[]; expiresAt: number } | undefined;

  const imageServers = async (
    timeoutMs: number,
  ): Promise<Result<readonly string[], LinkPreviewFailure>> => {
    if (cdn !== undefined && cdn.expiresAt > now()) return ok(cdn.servers);
    const result = await http.getJson(`${API_BASE}/cdn`, PROVIDER_NAME, timeoutMs);
    if (!result.ok) return result;
    const parsed = cdnSchema.safeParse(result.value);
    const servers = parsed.success
      ? parsed.data.image_servers
          .map((server) => server.replace(/\/+$/, ''))
          .filter((server) => isSafeGalleryUrl(`${server}/`))
      : [];
    if (servers.length === 0) return err(invalidResponseError(PROVIDER_NAME));
    cdn = { servers, expiresAt: now() + CDN_TTL_MS };
    return ok(servers);
  };

  return {
    name: PROVIDER_NAME,
    parse: (url: URL): GalleryRef | undefined => {
      if (!HOSTS.has(url.hostname.toLowerCase())) return undefined;
      const match = PATH_RE.exec(url.pathname);
      const id = match?.[1];
      if (id === undefined) return undefined;
      const page = match?.[2] === undefined ? undefined : Number(match[2]);
      return page === undefined || page < 1 ? { id } : { id, page };
    },
    fetch: async (id, timeoutMs) => {
      if (!GALLERY_ID_PATTERN.test(id)) return ok(null);
      const [body, servers] = await Promise.all([
        http.getJson(`${API_BASE}/galleries/${id}`, PROVIDER_NAME, timeoutMs),
        imageServers(timeoutMs),
      ]);
      if (!body.ok) return body;
      if (body.value === null) return ok(null);
      if (!servers.ok) return servers;
      const parsed = gallerySchema.safeParse(body.value);
      if (!parsed.success) return err(invalidResponseError(PROVIDER_NAME));
      const data = parsed.data;
      const title = firstText(data.title.english, data.title.pretty, data.title.japanese);
      if (title === undefined || data.pages.length === 0) return ok(null);
      const japanese = firstText(data.title.japanese);
      const gallery: Gallery = {
        source: PROVIDER_NAME,
        id: String(data.id),
        url: `https://nhentai.net/g/${data.id}/`,
        title,
        ...(japanese === undefined || japanese === title ? {} : { subtitle: japanese }),
        tags: groupTags(data.tags),
        pages: data.pages.map((page, index) => ({
          urls: rotated(servers.value, index).map(
            (server) => `${server}/${page.path.replace(/^\/+/, '')}`,
          ),
        })),
        ...(data.num_favorites === undefined ? {} : { favorites: data.num_favorites }),
        ...(data.upload_date === undefined ? {} : { uploadedAt: data.upload_date * 1000 }),
      };
      return ok(gallery);
    },
  };
};
