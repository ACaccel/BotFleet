/**
 * Paged gallery reader shared by the link-preview plugin, which posts a
 * gallery's first page, and the page buttons, which turn it.
 *
 * Smooth paging comes from three layers, all in process memory:
 *   - gallery metadata (title, tags, page URLs) is cached for 30 minutes and
 *     concurrent reads of one gallery share a single request;
 *   - downloaded page images live in a byte-bounded LRU;
 *   - every page shown schedules prefetches of the next `prefetchPages`
 *     pages and the previous one, at lower priority than any page someone
 *     is waiting for.
 *
 * With a {@link GalleryStagingPort}, prefetched pages are also uploaded to
 * Discord ahead of time, so turning to one only swaps the embed's image URL
 * instead of uploading during the turn. Staging runs in batches: once any
 * page in the prefetch window lacks a usable upload, the window is doubled
 * and every missing page in it is uploaded, nearest first, in messages that
 * grow from one page. A staged page whose gallery is cached is served
 * synchronously through {@link GalleryReaderService.stagedPage}, so the
 * caller can answer the turn in a single response. A page with no usable
 * upload is returned as bytes for the caller to attach directly.
 *
 * Page URLs can carry expiring signatures. When every candidate URL of a
 * page answers "gone", the gallery is refetched once and the page retried
 * with its fresh URLs.
 *
 * Page turns on one message are serialized through {@link serialize}, so
 * two members pressing buttons at once cannot interleave their edits.
 */
import type { Logger } from '../../core/logger';
import type {
  Gallery,
  GalleryHttp,
  GalleryImage,
  GallerySource,
  GallerySourceName,
} from '../../infra/link-preview';
import { DownloadLimiter } from './download-limiter';
import { GalleryImageCache } from './image-cache';

const METADATA_TTL_MS = 30 * 60 * 1000;
const METADATA_MAX_ENTRIES = 128;
const IMAGE_TTL_MS = 30 * 60 * 1000;
const MAX_CONCURRENT_DOWNLOADS = 4;
const MAX_QUEUED_PREFETCHES = 48;
const MAX_STAGED_ENTRIES = 4096;
/** A staged URL is reused only while it stays valid at least this long. */
const STAGED_URL_MARGIN_MS = 60 * 60 * 1000;
/**
 * Largest staging upload. Uploads start at one page and double up to this,
 * so the nearest pages are ready early and a long window needs few messages
 * under the channel's send rate limit.
 */
const STAGE_MAX_CHUNK_PAGES = 8;

/** A page already uploaded to Discord; `expiresAt` is when its URL stops working. */
export interface StagedPage {
  readonly url: string;
  readonly expiresAt: number;
}

/**
 * Uploads pages ahead of time. The result is aligned with `files`, with
 * `undefined` for a page that could not be staged; it never rejects.
 */
export interface GalleryStagingPort {
  stage(
    files: ReadonlyArray<{ readonly name: string; readonly image: GalleryImage }>,
  ): Promise<ReadonlyArray<StagedPage | undefined>>;
}

/** How a page reaches Discord: a staged URL, or bytes to attach. */
export type GalleryPageMedia =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'file'; readonly image: GalleryImage };

export interface GalleryReaderOptions {
  readonly sources: readonly GallerySource[];
  readonly http: Pick<GalleryHttp, 'getImage'>;
  /** Pages after the one shown to download ahead; `0` disables prefetching. */
  readonly prefetchPages: number;
  readonly cacheMaxBytes: number;
  readonly maxImageBytes: number;
  readonly imageTimeoutMs: number;
  readonly metadataTimeoutMs: number;
  /** Absent when no staging channel is configured or usable. */
  readonly staging?: GalleryStagingPort;
  readonly logger?: Logger;
  readonly now?: () => number;
}

/**
 * `not_found`: the gallery no longer exists upstream. `unavailable`: the
 * source or every image mirror failed; trying again later may work.
 */
export type GalleryPageOutcome =
  | {
      readonly status: 'ok';
      readonly gallery: Gallery;
      /** 1-based page actually shown, clamped to the gallery. */
      readonly page: number;
      readonly media: GalleryPageMedia;
    }
  | { readonly status: 'not_found' }
  | { readonly status: 'unavailable' };

type GalleryLookup = Gallery | 'not_found' | 'unavailable';

const galleryKey = (source: GallerySourceName, id: string): string => `${source}:${id}`;
const imageKey = (gallery: Gallery, index: number): string =>
  `${galleryKey(gallery.source, gallery.id)}:${index}`;

/** The attachment name a page is uploaded under, shared by staging and direct uploads. */
export const galleryPageFileName = (gallery: Gallery, page: number, image: GalleryImage): string =>
  `${gallery.source}-${gallery.id}-${page}.${image.extension}`;

export class GalleryReaderService {
  private readonly sources: ReadonlyMap<GallerySourceName, GallerySource>;
  private readonly metadata = new Map<string, { gallery: Gallery; expiresAt: number }>();
  private readonly metadataInFlight = new Map<string, Promise<GalleryLookup>>();
  private readonly images: GalleryImageCache;
  private readonly imagesInFlight = new Map<string, Promise<GalleryImage | 'gone' | undefined>>();
  private readonly limiter = new DownloadLimiter(MAX_CONCURRENT_DOWNLOADS, MAX_QUEUED_PREFETCHES);
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly staged = new Map<string, StagedPage>();
  private readonly stagingKeys = new Set<string>();
  private readonly now: () => number;

  public constructor(private readonly options: GalleryReaderOptions) {
    this.sources = new Map(options.sources.map((source) => [source.name, source]));
    this.now = options.now ?? Date.now;
    this.images = new GalleryImageCache(options.cacheMaxBytes, IMAGE_TTL_MS, this.now);
  }

  public supports(source: string): source is GallerySourceName {
    return this.sources.has(source as GallerySourceName);
  }

  /** Seed the metadata cache with a gallery the preview provider just read. */
  public remember(gallery: Gallery): void {
    const key = galleryKey(gallery.source, gallery.id);
    this.metadata.delete(key);
    while (this.metadata.size >= METADATA_MAX_ENTRIES) {
      const oldest = this.metadata.keys().next().value;
      if (oldest === undefined) break;
      this.metadata.delete(oldest);
    }
    this.metadata.set(key, { gallery, expiresAt: this.now() + METADATA_TTL_MS });
  }

  /**
   * The page at once, without any network wait, when its gallery is cached
   * and the page already staged; `undefined` otherwise. Schedules its
   * neighbours like {@link loadPage}.
   */
  public stagedPage(
    source: GallerySourceName,
    id: string,
    page: number,
  ): GalleryPageOutcome | undefined {
    const cached = this.metadata.get(galleryKey(source, id));
    if (cached === undefined || cached.expiresAt <= this.now()) return undefined;
    return this.servedStaged(cached.gallery, this.clampIndex(cached.gallery, page));
  }

  /** Load one page (clamped to the gallery) and schedule its neighbours. */
  public async loadPage(
    source: GallerySourceName,
    id: string,
    page: number,
  ): Promise<GalleryPageOutcome> {
    let gallery = await this.lookup(source, id);
    if (typeof gallery === 'string') return { status: gallery };
    let index = this.clampIndex(gallery, page);
    const staged = this.servedStaged(gallery, index);
    if (staged !== undefined) return staged;
    let image = await this.fetchImage(gallery, index, 'foreground');
    if (image === 'gone') {
      this.forget(gallery);
      gallery = await this.lookup(source, id);
      if (typeof gallery === 'string') return { status: gallery };
      index = this.clampIndex(gallery, page);
      image = await this.fetchImage(gallery, index, 'foreground');
    }
    if (image === undefined || image === 'gone') return { status: 'unavailable' };
    this.prefetchAround(gallery, index);
    return { status: 'ok', gallery, page: index + 1, media: { kind: 'file', image } };
  }

  /** Whether a task queued under `key` is still running or waiting. */
  public isBusy(key: string): boolean {
    return this.locks.has(key);
  }

  /** Run `task` after every earlier task queued under `key` has settled. */
  public serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, settled);
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return run;
  }

  private servedStaged(gallery: Gallery, index: number): GalleryPageOutcome | undefined {
    const url = this.stagedUrl(gallery, index);
    if (url === undefined) return undefined;
    this.prefetchAround(gallery, index);
    return { status: 'ok', gallery, page: index + 1, media: { kind: 'url', url } };
  }

  private clampIndex(gallery: Gallery, page: number): number {
    const last = gallery.pages.length - 1;
    return Math.min(Math.max(Math.trunc(page) - 1, 0), last);
  }

  private async lookup(source: GallerySourceName, id: string): Promise<GalleryLookup> {
    const key = galleryKey(source, id);
    const cached = this.metadata.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.gallery;
    const pending = this.metadataInFlight.get(key);
    if (pending !== undefined) return pending;
    const adapter = this.sources.get(source);
    if (adapter === undefined) return 'not_found';
    const request = adapter
      .fetch(id, this.options.metadataTimeoutMs)
      .then((result): GalleryLookup => {
        if (!result.ok) {
          this.options.logger?.warn(
            { err: result.error, source, galleryId: id },
            'gallery-reader: gallery metadata unavailable',
          );
          return 'unavailable';
        }
        if (result.value === null) return 'not_found';
        this.remember(result.value);
        return result.value;
      })
      .finally(() => this.metadataInFlight.delete(key));
    this.metadataInFlight.set(key, request);
    return request;
  }

  private forget(gallery: Gallery): void {
    const key = galleryKey(gallery.source, gallery.id);
    this.metadata.delete(key);
    this.images.deletePrefix(`${key}:`);
  }

  /**
   * The page image from cache, an in-flight download, or a new one.
   * `'gone'` means every candidate URL is stale; `undefined` is any other
   * failure, or a declined prefetch.
   */
  private fetchImage(
    gallery: Gallery,
    index: number,
    priority: 'foreground' | 'prefetch',
  ): Promise<GalleryImage | 'gone' | undefined> {
    const key = imageKey(gallery, index);
    const cached = this.images.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = this.imagesInFlight.get(key);
    if (pending !== undefined) {
      if (priority === 'foreground') this.limiter.promote(key);
      return pending;
    }
    const download = this.limiter
      .run(key, priority, () => this.download(gallery, index))
      .then((image) => {
        if (image !== undefined && image !== 'gone') this.images.set(key, image);
        return image;
      })
      .finally(() => this.imagesInFlight.delete(key));
    this.imagesInFlight.set(key, download);
    return download;
  }

  private async download(
    gallery: Gallery,
    index: number,
  ): Promise<GalleryImage | 'gone' | undefined> {
    const urls = gallery.pages[index]?.urls ?? [];
    let allGone = urls.length > 0;
    for (const url of urls) {
      const outcome = await this.options.http.getImage(
        url,
        this.options.maxImageBytes,
        this.options.imageTimeoutMs,
      );
      if (outcome.ok) return outcome.image;
      if (outcome.reason !== 'gone') allGone = false;
    }
    return allGone ? 'gone' : undefined;
  }

  private stagedUrl(gallery: Gallery, index: number): string | undefined {
    const key = imageKey(gallery, index);
    const entry = this.staged.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt - STAGED_URL_MARGIN_MS > this.now()) return entry.url;
    this.staged.delete(key);
    return undefined;
  }

  /** The page `index` itself, the `ahead` pages after it and the one before it. */
  private window(gallery: Gallery, index: number, ahead: number): number[] {
    const last = gallery.pages.length - 1;
    return [
      ...Array.from({ length: ahead }, (_, offset) => index + offset + 1),
      ...(ahead > 0 ? [index - 1] : []),
    ].filter((target) => target >= 0 && target <= last);
  }

  private prefetchAround(gallery: Gallery, index: number): void {
    const ahead = this.options.prefetchPages;
    if (ahead === 0) return;
    if (this.options.staging !== undefined) {
      // A page whose upload is already under way counts as covered, so a quick
      // run of turns does not split the window into one message per page.
      const needed = this.window(gallery, index, ahead).some(
        (target) =>
          this.stagedUrl(gallery, target) === undefined &&
          !this.stagingKeys.has(imageKey(gallery, target)),
      );
      // Nearest pages first; the page on screen, if it was attached directly, last.
      if (needed) void this.stageAhead(gallery, [...this.window(gallery, index, ahead * 2), index]);
      return;
    }
    for (const target of this.window(gallery, index, ahead)) {
      if (!this.limiter.acceptsPrefetch()) return;
      if (this.images.has(imageKey(gallery, target))) continue;
      void this.fetchImage(gallery, target, 'prefetch').catch(() => undefined);
    }
  }

  /**
   * Download every unstaged page in `targets` and upload them in order, in
   * growing batches, so the nearest pages become usable before the whole
   * window has downloaded. All downloads start at once; later chunks keep
   * downloading while earlier ones upload.
   */
  private async stageAhead(gallery: Gallery, targets: readonly number[]): Promise<void> {
    const staging = this.options.staging;
    if (staging === undefined) return;
    const pending = targets.filter(
      (target) =>
        this.stagedUrl(gallery, target) === undefined &&
        !this.stagingKeys.has(imageKey(gallery, target)),
    );
    for (const target of pending) this.stagingKeys.add(imageKey(gallery, target));
    const downloads = pending.map((target) =>
      this.fetchImage(gallery, target, 'prefetch').catch(() => undefined),
    );
    // The next page goes up alone so it is ready soonest; later batches grow.
    for (let offset = 0, size = 1; offset < pending.length; ) {
      const chunk = pending.slice(offset, offset + size);
      const chunkDownloads = downloads.slice(offset, offset + size);
      offset += size;
      size = Math.min(size * 2, STAGE_MAX_CHUNK_PAGES);
      try {
        const images = await Promise.all(chunkDownloads);
        const ready = chunk.flatMap((target, position) => {
          const image = images[position];
          return image === undefined || image === 'gone' ? [] : [{ target, image }];
        });
        if (ready.length === 0) continue;
        const results = await staging.stage(
          ready.map(({ target, image }) => ({
            name: galleryPageFileName(gallery, target + 1, image),
            image,
          })),
        );
        ready.forEach(({ target }, position) => {
          const result = results[position];
          if (result !== undefined) this.rememberStaged(imageKey(gallery, target), result);
        });
      } finally {
        for (const target of chunk) this.stagingKeys.delete(imageKey(gallery, target));
      }
    }
  }

  private rememberStaged(key: string, page: StagedPage): void {
    this.staged.delete(key);
    while (this.staged.size >= MAX_STAGED_ENTRIES) {
      const oldest = this.staged.keys().next().value;
      if (oldest === undefined) break;
      this.staged.delete(oldest);
    }
    this.staged.set(key, page);
  }
}
