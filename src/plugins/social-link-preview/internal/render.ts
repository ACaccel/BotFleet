/**
 * Render a {@link LinkPreviewResult} into a Discord reply.
 *
 * This is the one place that branches on the result mechanism:
 *   - `rewritten-url`: reply with the proxy URL as plain content so
 *     Discord unfurls it into a (playable) embed;
 *   - `card`: build an {@link EmbedBuilder} from the neutral OpenGraph
 *     card and attach Facebook video when a bounded download succeeds.
 *
 * Every reply uses `allowedMentions: { parse: [] }` so preview content
 * can never trigger an @everyone / @role ping (matches `llm-chat`).
 */
import {
  AttachmentBuilder,
  DiscordAPIError,
  EmbedBuilder,
  HTTPError,
  type Message,
} from 'discord.js';

import type { Translator } from '../../../core/i18n';
import type { LinkPreviewResult, PreviewCard } from '../../../infra/link-preview';
import { downloadPreviewVideo } from '../../../infra/link-preview';

const NO_MENTIONS = { parse: [] as const };
/** Neutral accent for bot-built preview cards. */
const EMBED_COLOR = 0x2b90d9;
const MAX_TITLE = 256;
const MAX_DESCRIPTION = 350;
const COMPACT_COUNT = /^(?:0|[1-9]\d*)(?:\.\d+)?[KMBT]$/i;

const isDisplayableCount = (count: number | string | undefined): count is number | string =>
  typeof count === 'number'
    ? Number.isSafeInteger(count) && count >= 0
    : typeof count === 'string' && COMPACT_COUNT.test(count);

const truncate = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const prefix = text.slice(0, max - 3).replace(/[\uD800-\uDBFF]$/, '');
  return `${prefix}...`;
};

const truncateDescription = (text: string): string => {
  const characters = Array.from(text);
  return characters.length <= MAX_DESCRIPTION
    ? text
    : `${characters.slice(0, MAX_DESCRIPTION - 3).join('')}...`;
};

/** Build a static embed from a neutral preview card. Exported for tests. */
export const buildCardEmbed = (card: PreviewCard, translator: Translator): EmbedBuilder => {
  const facebook = card.siteName === 'Facebook';
  const embed = new EmbedBuilder().setColor(facebook ? 0x1877f2 : EMBED_COLOR);
  if (facebook) {
    embed.setAuthor({
      name: 'Facebook',
      iconURL: 'https://www.facebook.com/images/fb_icon_325x325.png',
    });
  }
  const title = facebook ? card.authorName || card.title || 'Facebook' : card.title;
  if (title !== undefined && title.length > 0) {
    embed.setTitle(truncate(title, MAX_TITLE));
    embed.setURL(card.url);
  }
  if (card.description !== undefined && card.description.length > 0) {
    embed.setDescription(truncateDescription(card.description));
  }
  if (facebook) {
    const statistics = (['likes', 'comments', 'shares'] as const).flatMap((metric) => {
      const count = card.engagement?.[metric];
      return isDisplayableCount(count)
        ? [translator.t(`replies:social_link_preview.engagement_${metric}`, { count })]
        : [];
    });
    if (statistics.length > 0) embed.setFooter({ text: statistics.join(' · ') });
  }
  // Only set an https image: Discord requires it, and it prevents a
  // scraped page from injecting a non-https (or javascript:) image URL.
  if (card.imageUrl !== undefined && card.imageUrl.startsWith('https://')) {
    embed.setImage(card.imageUrl);
  }
  if (!facebook && card.siteName !== undefined && card.siteName.length > 0) {
    embed.setFooter({
      text: translator.t('replies:social_link_preview.embed_footer', { provider: card.siteName }),
    });
  }
  return embed;
};

export interface PreviewRenderOptions {
  readonly maxVideoBytes?: number;
  readonly videoTimeoutMs?: number;
  readonly downloadVideo?: (
    url: string,
    maxBytes: number,
    timeoutMs: number,
  ) => Promise<{ data: Buffer; name: string } | null>;
}

const isUploadRejection = (error: unknown): boolean =>
  (error instanceof DiscordAPIError &&
    (error.code === 40005 ||
      error.code === 50045 ||
      error.code === 50013 ||
      error.status === 413)) ||
  (error instanceof HTTPError && error.status === 413);

export const renderPreview = async (
  message: Message,
  result: LinkPreviewResult,
  translator: Translator,
  options: PreviewRenderOptions = {},
): Promise<void> => {
  if (result.kind === 'rewritten-url') {
    await message.reply({ content: result.url, allowedMentions: NO_MENTIONS });
    return;
  }
  if (result.card.siteName === 'Facebook' && result.media !== undefined) {
    const maxBytes = options.maxVideoBytes ?? 8 * 1024 * 1024;
    const download = options.downloadVideo ?? downloadPreviewVideo;
    const video = await download(
      result.media.url,
      maxBytes,
      options.videoTimeoutMs ?? 15_000,
    ).catch(() => null);
    if (video !== null) {
      try {
        await message.reply({
          embeds: [buildCardEmbed({ ...result.card, imageUrl: undefined }, translator)],
          files: [new AttachmentBuilder(video.data, { name: video.name })],
          allowedMentions: NO_MENTIONS,
        });
        return;
      } catch (error) {
        if (!isUploadRejection(error)) throw error;
      }
    }
    await message.reply({
      content: `<${result.media.fallbackUrl}>`,
      embeds: [buildCardEmbed(result.card, translator)],
      allowedMentions: NO_MENTIONS,
    });
    return;
  }
  await message.reply({
    embeds: [buildCardEmbed(result.card, translator)],
    allowedMentions: NO_MENTIONS,
  });
};
