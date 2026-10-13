/** Reply adapter for the shared Discord preview renderer. */
import type { Message } from 'discord.js';
import type { Translator } from '../../../core/i18n';
import type { LinkPreviewResult } from '../../../infra/link-preview';
import { renderPreviewTo, type PreviewRenderOptions } from '../../../infra/discord/social-preview';

export { buildCardEmbed } from '../../../infra/discord/social-preview';

export const renderPreview = (
  message: Message,
  result: LinkPreviewResult,
  translator: Translator,
  options: PreviewRenderOptions = {},
): Promise<void> =>
  renderPreviewTo((payload) => message.reply(payload), result, translator, options);
