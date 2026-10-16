/** Reply adapter for the shared Discord preview renderer. */
import type { Message } from 'discord.js';
import type { Translator } from '../../../core/i18n';
import type { RenderablePreviewResult } from '../../../infra/link-preview';
import { renderPreviewTo, type PreviewRenderOptions } from '../../../infra/discord/social-preview';

export { buildCardEmbed } from '../../../infra/discord/social-preview';

/** Keep thumbnails and source links while withholding downloadable video variants. */
const withoutDownloads = (result: RenderablePreviewResult): RenderablePreviewResult => {
  if (result.kind === 'card') {
    return { kind: 'card', card: result.card, sourceUrl: result.sourceUrl };
  }
  if (result.kind === 'post' && result.post.video !== undefined) {
    return { ...result, post: { ...result.post, video: { ...result.post.video, variants: [] } } };
  }
  return result;
};

export const renderPreview = (
  message: Message,
  result: RenderablePreviewResult,
  translator: Translator,
  options: PreviewRenderOptions & { readonly videoEnabled?: boolean } = {},
): Promise<void> =>
  renderPreviewTo(
    (payload) => message.reply(payload),
    options.videoEnabled === false ? withoutDownloads(result) : result,
    translator,
    options,
  );
