/**
 * Adapts a {@link GallerySource} to the {@link LinkPreviewProvider}
 * Strategy, so gallery links share URL extraction, the provider kill-switch
 * and per-guild provider preferences with every other preview source.
 */
import { ok } from '../../../core/result';
import type { LinkPreviewProvider } from '../types';
import type { GallerySource } from './source';

export const createGalleryPreviewProvider = (source: GallerySource): LinkPreviewProvider => ({
  name: source.name,
  canHandle: (url) => source.parse(url) !== undefined,
  build: async (url, ctx) => {
    const ref = source.parse(url);
    if (ref === undefined) return ok(null);
    const result = await source.fetch(ref.id, ctx.timeoutMs);
    if (!result.ok) return result;
    const gallery = result.value;
    if (gallery === null) return ok(null);
    const startPage = Math.min(Math.max(ref.page ?? 1, 1), gallery.pages.length);
    return ok({ kind: 'gallery', gallery, startPage, sourceUrl: url.href });
  },
});
