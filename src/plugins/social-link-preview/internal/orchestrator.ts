/**
 * Orchestrates social-link-preview handling for one message once the
 * plugin's cheap guards have passed.
 *
 * Sequence: extract candidate URLs -> for each, find a provider ->
 * build the preview -> render the reply -> apply the original-message
 * strategy. Bounded by `maxUrlsPerMessage` previews. Every failure mode
 * is silent to the channel: a provider `Err` is logged and skipped, a
 * `null` result (matched but not previewable) is skipped cleanly, a
 * message withdrawn while its preview was being built ends the pass at
 * debug level, and suppression failures are swallowed inside
 * {@link applyOriginalMessageStrategy}.
 *
 * Gallery links (nhentai, wnacg) are skipped outside age-restricted
 * channels before any request is made, and otherwise become a paged reader
 * message posted through the shared {@link GalleryReaderService}.
 */
import type { Message } from 'discord.js';

import type { GalleryReaderService } from '../../../application/gallery-reader/service';
import { buildGalleryMessage } from '../../../application/gallery-reader/view';
import { logError, type Logger } from '../../../core/logger';
import { bindTranslator, type Translator } from '../../../core/i18n';
import { isAgeRestrictedChannel } from '../../../infra/discord';
import { isUnknownMessageReferenceError } from '../../../infra/discord/unknown-message-reference';
import {
  isGallerySourceName,
  type LinkPreviewProviderRegistry,
  type LinkPreviewResult,
} from '../../../infra/link-preview';
import type { SocialLinkPreviewPluginConfig } from '../config';
import { extractUrls } from './extract-urls';
import { renderPreview } from './render';
import { applyOriginalMessageStrategy } from './suppress';

/** Operator-facing debug line for the withdrawn-message race (no scattered literals). */
const LOG_MESSAGE_WITHDRAWN =
  'social-link-preview: original message deleted before its preview was posted; skipped';
const LOG_GALLERY_UNAVAILABLE = 'social-link-preview: gallery page unavailable; skipped';

type GalleryReader = Pick<GalleryReaderService, 'remember' | 'loadPage'>;

/** Collaborators for {@link runSocialLinkPreview}; all injectable for tests. */
interface RunSocialLinkPreviewDeps {
  readonly registry: LinkPreviewProviderRegistry;
  readonly config: Pick<
    SocialLinkPreviewPluginConfig,
    | 'originalMessageStrategy'
    | 'timeoutMs'
    | 'maxUrlsPerMessage'
    | 'maxVideoBytes'
    | 'videoTimeoutMs'
  >;
  readonly translator: Translator;
  readonly logger: Logger;
  readonly providers?: ReadonlySet<string>;
  readonly videoEnabled?: boolean;
  /** Absent when gallery previews are off; gallery links are then ignored. */
  readonly galleryReader?: GalleryReader;
}

/** Post a gallery's reader message; `false` when its page could not be loaded. */
const postGallery = async (
  message: Message,
  preview: Extract<LinkPreviewResult, { readonly kind: 'gallery' }>,
  reader: GalleryReader,
  deps: Pick<RunSocialLinkPreviewDeps, 'translator' | 'logger'>,
): Promise<boolean> => {
  const { gallery } = preview;
  reader.remember(gallery);
  const outcome = await reader.loadPage(gallery.source, gallery.id, preview.startPage);
  if (outcome.status !== 'ok') {
    deps.logger.debug(
      { guildId: message.guildId, source: gallery.source, galleryId: gallery.id, outcome },
      LOG_GALLERY_UNAVAILABLE,
    );
    return false;
  }
  await message.reply(
    buildGalleryMessage(
      outcome.gallery,
      outcome.page,
      outcome.media,
      bindTranslator(deps.translator),
    ),
  );
  return true;
};

export const runSocialLinkPreview = async (
  deps: RunSocialLinkPreviewDeps,
  message: Message,
): Promise<void> => {
  const urls = extractUrls(message.content);
  if (urls.length === 0) return;

  let previewed = 0;
  for (const url of urls) {
    if (previewed >= deps.config.maxUrlsPerMessage) break;

    const provider = deps.registry.findProvider(url);
    if (provider === undefined) continue;
    if (deps.providers !== undefined && !deps.providers.has(provider.name)) continue;
    if (
      isGallerySourceName(provider.name) &&
      (deps.galleryReader === undefined || !isAgeRestrictedChannel(message.channel))
    ) {
      continue;
    }

    const result = await provider.build(url, {
      timeoutMs: deps.config.timeoutMs,
      logger: deps.logger,
    });
    if (!result.ok) {
      logError(deps.logger, message.guildId, result.error);
      continue;
    }
    if (result.value === null) continue; // matched host but not previewable

    const preview = result.value;
    try {
      if (preview.kind === 'gallery') {
        if (deps.galleryReader === undefined) continue;
        if (!(await postGallery(message, preview, deps.galleryReader, deps))) continue;
      } else {
        await renderPreview(message, preview, deps.translator, {
          maxVideoBytes: deps.config.maxVideoBytes,
          videoTimeoutMs: deps.config.videoTimeoutMs,
          videoEnabled: deps.videoEnabled,
        });
      }
      await applyOriginalMessageStrategy(message, deps.config.originalMessageStrategy, deps.logger);
      previewed += 1;
    } catch (err: unknown) {
      // The author (or a moderator) removed the message while the probe
      // was running. Nothing is left to reply to and every remaining URL
      // would fail the same way, so end the pass; this is routine, not a
      // fault, so it is logged at debug rather than error.
      if (isUnknownMessageReferenceError(err)) {
        deps.logger.debug(
          { guildId: message.guildId, channelId: message.channelId, messageId: message.id },
          LOG_MESSAGE_WITHDRAWN,
        );
        return;
      }
      // A transient reply/API failure on one URL must not abort previews
      // for the message's remaining URLs.
      logError(deps.logger, message.guildId, err);
    }
  }
};
