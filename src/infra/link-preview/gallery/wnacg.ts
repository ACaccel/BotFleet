/**
 * wnacg source. The site has no API, so two pages are read in parallel:
 * the album index (title and tags) and the gallery script, a
 * `document.writeln` blob whose `imglist` names every page image.
 *
 * Requests always go to the canonical `www.wnacg.com` host whatever mirror
 * subdomain the link used. Page images are protocol-relative URLs with
 * expiring `verify` signatures; entries that are not protocol-relative are
 * site decoration (a trailing bookmark banner) and are dropped.
 */
import { ok } from '../../../core/result';
import { decodeEntities } from '../og-client';
import type { Gallery } from '../types';
import { isSafeGalleryUrl, type GalleryHttp } from './http';
import { GALLERY_ID_PATTERN, type GalleryRef, type GallerySource } from './source';

const PROVIDER_NAME = 'wnacg';
const SITE = 'https://www.wnacg.com';
const PATH_RE = /^\/photos-(?:index|slist|gallery|slide|webp)(?:-page-\d+)?-aid-(\d{1,9})\.html$/;
const TITLE_RE = /<h2>([\s\S]*?)<\/h2>/i;
const TAG_RE = /<a\s+class="tagshow"[^>]*>([^<]+)<\/a>/gi;
/** `url: fast_img_host+"//host/path"`, with the quotes escaped inside `document.writeln`. */
const PAGE_URL_RE = /url:\s*fast_img_host\s*\+\s*\\?"(\/\/[^"\\\s]+)\\?"/g;

const isWnacgHost = (host: string): boolean =>
  ['wnacg.com', 'wnacg.org'].some((domain) => host === domain || host.endsWith(`.${domain}`));

const textOf = (html: string): string =>
  decodeEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();

const parseWnacgTitle = (html: string): string | undefined => {
  const raw = TITLE_RE.exec(html)?.[1];
  const title = raw === undefined ? '' : textOf(raw);
  return title.length > 0 ? title : undefined;
};

const parseWnacgTags = (html: string): string[] => [
  ...new Set([...html.matchAll(TAG_RE)].map((match) => textOf(match[1] ?? '')).filter(Boolean)),
];

const parseWnacgPageUrls = (script: string): string[] =>
  [...script.matchAll(PAGE_URL_RE)]
    .map((match) => `https:${match[1] ?? ''}`)
    .filter(isSafeGalleryUrl);

export const createWnacgSource = (http: GalleryHttp): GallerySource => ({
  name: PROVIDER_NAME,
  parse: (url: URL): GalleryRef | undefined => {
    if (!isWnacgHost(url.hostname.toLowerCase())) return undefined;
    const id = PATH_RE.exec(url.pathname)?.[1];
    return id === undefined ? undefined : { id };
  },
  fetch: async (id, timeoutMs) => {
    if (!GALLERY_ID_PATTERN.test(id)) return ok(null);
    const [index, script] = await Promise.all([
      http.getText(`${SITE}/photos-index-aid-${id}.html`, PROVIDER_NAME, timeoutMs),
      http.getText(`${SITE}/photos-gallery-aid-${id}.html`, PROVIDER_NAME, timeoutMs),
    ]);
    if (!index.ok) return index;
    if (!script.ok) return script;
    if (index.value === null || script.value === null) return ok(null);
    const title = parseWnacgTitle(index.value);
    const pages = parseWnacgPageUrls(script.value);
    // A missing album answers 200 with a page that has neither.
    if (title === undefined || pages.length === 0) return ok(null);
    const tags = parseWnacgTags(index.value);
    const gallery: Gallery = {
      source: PROVIDER_NAME,
      id,
      url: `${SITE}/photos-index-aid-${id}.html`,
      title,
      tags: tags.length === 0 ? [] : [{ type: 'tag', names: tags }],
      pages: pages.map((url) => ({ urls: [url] })),
    };
    return ok(gallery);
  },
});
