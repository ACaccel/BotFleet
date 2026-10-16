/**
 * `infra/link-preview` barrel. Discord-specific rendering lives in
 * `infra/discord/social-preview.ts`; consuming plugins own reply/send
 * adapters and message suppression.
 */
export type {
  LinkPreviewProvider,
  LinkPreviewProviderName,
  LinkPreviewResult,
  RenderablePreviewResult,
  Gallery,
  GalleryPage,
  GalleryTagGroup,
  GallerySourceName,
  LinkPreviewBuildContext,
  LinkPreviewFailure,
  PreviewCard,
  SocialPost,
  PostVideoVariant,
} from './types';
export { LINK_PREVIEW_PROVIDER_NAMES, GALLERY_SOURCE_NAMES, isGallerySourceName } from './types';

export { LinkPreviewProviderRegistry } from './registry';
export { createDefaultLinkPreviewRegistry } from './default-registry';

export { OgClient, parseOpenGraph, type OpenGraphMeta } from './og-client';
export { downloadPreviewVideo, type PreviewVideo } from './video-client';
export { translateLinkPreviewError, invalidResponseError } from './error-translator';

export { createRewriteProvider } from './providers/rewrite-provider';
export { createTwitterProvider } from './providers/twitter';
export { createInstagramProvider } from './providers/instagram';
export { createThreadsProvider } from './providers/threads';
export { createFacebookProvider } from './providers/facebook';
export { createRedditProvider } from './providers/reddit';
export { createBahamutProvider } from './providers/bahamut';
export { createBilibiliProvider } from './providers/bilibili';

export {
  createDefaultGallerySources,
  createGalleryHttp,
  createGalleryPreviewProvider,
  createNhentaiSource,
  createWnacgSource,
  type GalleryHttp,
  type GalleryImage,
  type GalleryImageOutcome,
  type GalleryRef,
  type GallerySource,
} from './gallery';
