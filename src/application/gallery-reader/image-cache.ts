/**
 * Byte-bounded LRU of downloaded page images.
 *
 * Map insertion order is the recency order: a hit is re-inserted at the
 * end, and eviction removes from the front until the total fits the
 * budget. Entries also expire, because a page's source URL (and so the
 * right to show it) may be withdrawn upstream.
 */
import type { GalleryImage } from '../../infra/link-preview';

interface Entry {
  readonly image: GalleryImage;
  readonly expiresAt: number;
}

export class GalleryImageCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;

  public constructor(
    private readonly maxBytes: number,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  public get(key: string): GalleryImage | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= this.now()) {
      this.bytes -= entry.image.data.length;
      return undefined;
    }
    this.entries.set(key, entry);
    return entry.image;
  }

  public has(key: string): boolean {
    const entry = this.entries.get(key);
    return entry !== undefined && entry.expiresAt > this.now();
  }

  /** An image larger than the whole budget is not cached at all. */
  public set(key: string, image: GalleryImage): void {
    const size = image.data.length;
    if (size > this.maxBytes) return;
    this.delete(key);
    while (this.bytes + size > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    this.entries.set(key, { image, expiresAt: this.now() + this.ttlMs });
    this.bytes += size;
  }

  /** Drop every page of one gallery, after its page URLs were found stale. */
  public deletePrefix(prefix: string): void {
    for (const key of [...this.entries.keys()]) if (key.startsWith(prefix)) this.delete(key);
  }

  public get totalBytes(): number {
    return this.bytes;
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.bytes -= entry.image.data.length;
  }
}
