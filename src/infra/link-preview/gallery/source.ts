/**
 * Gallery source Strategy. A source recognises its own gallery links and
 * reads one gallery's metadata and page list; it never downloads page
 * images (the consumer does, through {@link GalleryHttp.getImage}).
 */
import type { Result } from '../../../core/result';
import type { Gallery, GallerySourceName, LinkPreviewFailure } from '../types';

/** A gallery a link points at, optionally at a specific 1-based page. */
export interface GalleryRef {
  readonly id: string;
  readonly page?: number;
}

export interface GallerySource {
  readonly name: GallerySourceName;
  /** Pure host/path test, as in `LinkPreviewProvider.canHandle`. */
  parse(url: URL): GalleryRef | undefined;
  /**
   * Read gallery `id`. `Ok(null)` means it does not exist or has no
   * displayable page; `Err` is an upstream or parse failure.
   */
  fetch(id: string, timeoutMs: number): Promise<Result<Gallery | null, LinkPreviewFailure>>;
}

/** Gallery identifiers are short digit strings on both supported sources. */
export const GALLERY_ID_PATTERN = /^\d{1,9}$/;
