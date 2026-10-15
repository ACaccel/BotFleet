/**
 * Render a static link preview through a Discord send or reply adapter.
 * Galleries are interactive and rendered by their own reader instead.
 *
 * This is the one place that branches on the result mechanism:
 *   - `rewritten-url`: reply with the proxy URL as plain content so
 *     Discord unfurls it into a (playable) embed;
 *   - `card`: build an {@link EmbedBuilder} from the neutral OpenGraph
 *     card, or a Components V2 card with video below its metadata when a
 *     bounded download succeeds;
 *   - `post`: a custom X card (see `social-post.ts`). A video post uploads
 *     the largest encoding that fits in a Components V2 card, and falls back
 *     to a thumbnail embed linking the video when none can be uploaded.
 *
 * Every reply uses `allowedMentions: { parse: [] }` so preview content
 * can never trigger an @everyone / @role ping (matches `llm-chat`).
 */
import { EMBED_COLORS, SOCIAL_COLORS } from './presentation-colors';
import {
  AttachmentBuilder,
  ContainerBuilder,
  DiscordAPIError,
  EmbedBuilder,
  HTTPError,
  MediaGalleryBuilder,
  MessageFlags,
  TextDisplayBuilder,
  escapeMarkdown,
  type MessageCreateOptions,
} from 'discord.js';

import type { Translator } from '../../core/i18n';
import type { PreviewCard, RenderablePreviewResult, SocialPost } from '../link-preview';
import { downloadPreviewVideo } from '../link-preview';
import { buildPostContainer, buildPostEmbeds, pickVideoVariants } from './social-post';

export type PreviewSender = (payload: MessageCreateOptions) => Promise<unknown>;

const NO_MENTIONS = { parse: [] as const };
const DEFAULT_MAX_VIDEO_BYTES = 8 * 1024 * 1024;
const DEFAULT_VIDEO_TIMEOUT_MS = 15_000;
const MAX_TITLE = 256;
const MAX_DESCRIPTION = 350;
const IMAGES_PER_GALLERY = 4;
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
  const embed = new EmbedBuilder().setColor(facebook ? SOCIAL_COLORS.facebook : EMBED_COLORS.info);
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

/** Keep uploaded media after all card metadata in a single ordered message. */
const buildVideoCardContainer = (
  card: PreviewCard,
  translator: Translator,
  videoUrl: string,
  announcement?: string,
): ContainerBuilder => {
  const embed = buildCardEmbed({ ...card, imageUrl: undefined }, translator).toJSON();
  const escapeText = (text: string): string =>
    escapeMarkdown(text, { heading: true, maskedLink: true });
  const container = new ContainerBuilder().setAccentColor(embed.color ?? EMBED_COLORS.info);
  const text = [
    announcement,
    embed.author === undefined ? undefined : `**${escapeText(embed.author.name)}**`,
    embed.title === undefined ? undefined : `**[${escapeText(embed.title)}](${card.url})**`,
    embed.description === undefined ? undefined : escapeText(embed.description),
    embed.footer === undefined ? undefined : `-# ${escapeText(embed.footer.text)}`,
  ].filter((part): part is string => part !== undefined && part.length > 0);
  if (embed.title === undefined) text.push(`<${card.url}>`);
  for (const content of text) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
  }
  return container.addMediaGalleryComponents(
    new MediaGalleryBuilder().addItems((item) => item.setURL(videoUrl)),
  );
};

export interface PreviewRenderOptions {
  /** Localized feed announcement, included in the same delivery as the preview. */
  readonly announcement?: string;
  readonly maxVideoBytes?: number;
  readonly videoTimeoutMs?: number;
  readonly downloadVideo?: (
    url: string,
    maxBytes: number,
    timeoutMs: number,
  ) => Promise<{ data: Buffer; name: string } | null>;
}

/** Send every source image without exceeding Discord's four-image gallery. */
const replyWithCard = async (
  send: PreviewSender,
  card: PreviewCard,
  translator: Translator,
  content?: string,
): Promise<void> => {
  const images = [
    ...new Set([...(card.imageUrl ? [card.imageUrl] : []), ...(card.imageUrls ?? [])]),
  ].filter((image) => image.startsWith('https://'));
  const main = buildCardEmbed({ ...card, imageUrl: images[0] }, translator).setURL(card.url);
  for (let offset = 0; offset < Math.max(images.length, 1); offset += IMAGES_PER_GALLERY) {
    const batch = images.slice(offset, offset + IMAGES_PER_GALLERY);
    const embeds =
      offset === 0
        ? [
            main,
            ...batch.slice(1).map((image) => new EmbedBuilder().setURL(card.url).setImage(image)),
          ]
        : batch.map((image) => new EmbedBuilder().setURL(card.url).setImage(image));
    await send({
      ...(offset === 0 && content !== undefined ? { content } : {}),
      embeds,
      allowedMentions: NO_MENTIONS,
    });
  }
};

const isUploadRejection = (error: unknown): boolean =>
  (error instanceof DiscordAPIError &&
    (error.code === 40005 ||
      error.code === 50045 ||
      error.code === 50013 ||
      error.status === 413)) ||
  (error instanceof HTTPError && error.status === 413);

/** Extension of a downloaded file name, defaulting to `mp4`. */
const extensionOf = (name: string): string => /\.([a-z0-9]+)$/i.exec(name)?.[1] ?? 'mp4';

/**
 * Reply with a custom X card. A video is uploaded inside a Components V2
 * card, trying the best encoding that fits and then the next one down when
 * the download or the upload fails; with nothing uploadable the classic
 * embed shows the thumbnail and links the video.
 */
const renderPost = async (
  send: PreviewSender,
  post: SocialPost,
  translator: Translator,
  options: PreviewRenderOptions,
): Promise<void> => {
  if (post.video !== undefined) {
    const maxBytes = options.maxVideoBytes ?? DEFAULT_MAX_VIDEO_BYTES;
    const download = options.downloadVideo ?? downloadPreviewVideo;
    for (const variant of pickVideoVariants(post.video, maxBytes)) {
      const video = await download(
        variant.url,
        maxBytes,
        options.videoTimeoutMs ?? DEFAULT_VIDEO_TIMEOUT_MS,
      ).catch(() => null);
      if (video === null) continue;
      const name = `x-video.${extensionOf(video.name)}`;
      try {
        await send({
          flags: MessageFlags.IsComponentsV2,
          components: [
            buildPostContainer(post, translator, `attachment://${name}`, options.announcement),
          ],
          files: [new AttachmentBuilder(video.data, { name })],
          allowedMentions: NO_MENTIONS,
        });
        return;
      } catch (error) {
        if (!isUploadRejection(error)) throw error;
      }
    }
  }
  await send({
    ...(options.announcement === undefined ? {} : { content: options.announcement }),
    embeds: buildPostEmbeds(post, translator),
    allowedMentions: NO_MENTIONS,
  });
};

export const renderPreviewTo = async (
  send: PreviewSender,
  result: RenderablePreviewResult,
  translator: Translator,
  options: PreviewRenderOptions = {},
): Promise<void> => {
  if (result.kind === 'rewritten-url') {
    await send({ content: options.announcement ?? result.url, allowedMentions: NO_MENTIONS });
    return;
  }
  if (result.kind === 'post') {
    await renderPost(send, result.post, translator, options);
    return;
  }
  if (result.media !== undefined) {
    const maxBytes = options.maxVideoBytes ?? DEFAULT_MAX_VIDEO_BYTES;
    const download = options.downloadVideo ?? downloadPreviewVideo;
    const video = await download(
      result.media.url,
      maxBytes,
      options.videoTimeoutMs ?? DEFAULT_VIDEO_TIMEOUT_MS,
    ).catch(() => null);
    if (video !== null) {
      try {
        await send({
          flags: MessageFlags.IsComponentsV2,
          components: [
            buildVideoCardContainer(
              result.card,
              translator,
              `attachment://${video.name}`,
              options.announcement,
            ),
          ],
          files: [new AttachmentBuilder(video.data, { name: video.name })],
          allowedMentions: NO_MENTIONS,
        });
        return;
      } catch (error) {
        if (!isUploadRejection(error)) throw error;
      }
    }
    await replyWithCard(
      send,
      result.card,
      translator,
      [options.announcement, `<${result.media.fallbackUrl}>`].filter(Boolean).join('\n'),
    );
    return;
  }
  await replyWithCard(send, result.card, translator, options.announcement);
};
