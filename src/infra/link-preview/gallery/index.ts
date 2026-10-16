/** Gallery sources (nhentai, wnacg) and their bounded HTTP access. */
import type { GalleryHttp } from './http';
import { createNhentaiSource } from './nhentai';
import type { GallerySource } from './source';
import { createWnacgSource } from './wnacg';

export {
  createGalleryHttp,
  type GalleryHttp,
  type GalleryImage,
  type GalleryImageOutcome,
} from './http';
export type { GalleryRef, GallerySource } from './source';
export { createNhentaiSource } from './nhentai';
export { createWnacgSource } from './wnacg';
export { createGalleryPreviewProvider } from './provider';

/** Every production gallery source, sharing one HTTP client. */
export const createDefaultGallerySources = (http: GalleryHttp): readonly GallerySource[] => [
  createNhentaiSource(http),
  createWnacgSource(http),
];
