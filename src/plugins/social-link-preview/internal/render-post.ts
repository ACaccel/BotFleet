/**
 * Discord layouts for a structured {@link SocialPost} (X).
 *
 * Two layouts, chosen by the renderer:
 *   - classic embeds for a post without an uploaded video. Up to four photos
 *     share the post URL, which Discord renders as one gallery card;
 *   - a Components V2 container for a post whose video the bot uploads, so
 *     the text and the playable video sit in the same card (an embed cannot
 *     carry video).
 *
 * Post text is escaped so upstream content cannot inject Discord markdown
 * (headings, masked links, spoilers). Counts are compacted (`1.2K`) to match
 * the platform's own display.
 */
import { SOCIAL_COLORS } from '../../../infra/discord/presentation-colors';
import {
  ContainerBuilder,
  EmbedBuilder,
  MediaGalleryBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  escapeMarkdown,
} from 'discord.js';

import type { Translator } from '../../../core/i18n';
import type { PostVideoVariant, SocialPost } from '../../../infra/link-preview';

const SITE_LABEL = 'X';
/** Discord renders at most four images per gallery card. */
const MAX_IMAGES = 4;
const MAX_TEXT = 1500;
const MAX_QUOTE = 300;
/** Leaves room for container overhead, so an estimate near the cap is not tried. */
const SIZE_MARGIN = 0.9;
/** Upload attempts per post; each failed one costs a download. */
const MAX_VIDEO_ATTEMPTS = 2;

const compactNumber = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const isHttps = (value: string | undefined): value is string =>
  value !== undefined && value.startsWith('https://');

const truncate = (text: string, max: number): string => {
  const characters = Array.from(text);
  return characters.length <= max ? text : `${characters.slice(0, max - 3).join('')}...`;
};

/**
 * Escape upstream text, including the line-start heading and masked-link
 * syntax that `escapeMarkdown` leaves alone by default: a post must not
 * render as a heading or hide a link target behind other text.
 */
const escapeText = (text: string): string =>
  escapeMarkdown(text, { heading: true, maskedLink: true });

const quoteLines = (text: string): string =>
  text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

const statsLine = (post: SocialPost, translator: Translator): string =>
  (['replies', 'reposts', 'likes', 'views'] as const)
    .flatMap((metric) => {
      const count = post.stats[metric];
      return count === undefined
        ? []
        : [
            translator.t(`replies:social_link_preview.post_${metric}`, {
              count: compactNumber.format(count),
            }),
          ];
    })
    .join(' · ');

/** Escaped post text, followed by the quoted post when there is one. */
const postBody = (post: SocialPost, translator: Translator): string => {
  const parts = [escapeText(truncate(post.text, MAX_TEXT))];
  if (post.quote !== undefined) {
    const header = translator.t('replies:social_link_preview.post_quote', {
      name: escapeText(post.quote.authorName),
      handle: post.quote.authorHandle,
      url: post.quote.url,
    });
    const text = escapeText(truncate(post.quote.text, MAX_QUOTE));
    parts.push(text.length > 0 ? `${header}\n${quoteLines(text)}` : header);
  }
  return parts.filter((part) => part.length > 0).join('\n\n');
};

/**
 * Classic embeds for a post. For a video post (whose video was not
 * uploaded) the thumbnail stands in for the media and a link points at
 * the video. Exported for tests.
 */
export const buildPostEmbeds = (post: SocialPost, translator: Translator): EmbedBuilder[] => {
  const images = post.images.filter(isHttps).slice(0, MAX_IMAGES);
  const thumbnail = post.video?.thumbnailUrl;
  if (images.length === 0 && isHttps(thumbnail)) images.push(thumbnail);

  let description = postBody(post, translator);
  if (post.video !== undefined) {
    const watch = translator.t('replies:social_link_preview.post_watch_video', { url: post.url });
    description = description.length > 0 ? `${description}\n\n${watch}` : watch;
  }
  const stats = statsLine(post, translator);
  const main = new EmbedBuilder()
    .setColor(SOCIAL_COLORS.x)
    .setAuthor({
      name: `${post.author.name} (@${post.author.handle})`,
      url: post.author.url,
      ...(isHttps(post.author.avatarUrl) ? { iconURL: post.author.avatarUrl } : {}),
    })
    .setURL(post.url)
    .setFooter({ text: stats.length > 0 ? `${SITE_LABEL} · ${stats}` : SITE_LABEL })
    .setTimestamp(post.createdAt);
  if (description.length > 0) main.setDescription(description);
  const [first, ...rest] = images;
  if (first !== undefined) main.setImage(first);
  // Embeds sharing the main embed's URL are merged into its image gallery.
  return [main, ...rest.map((image) => new EmbedBuilder().setURL(post.url).setImage(image))];
};

/**
 * A Components V2 card holding the post text, the uploaded video and the
 * counts. `videoUrl` is the `attachment://` reference of the upload.
 * Exported for tests.
 */
export const buildPostContainer = (
  post: SocialPost,
  translator: Translator,
  videoUrl: string,
): ContainerBuilder => {
  const heading = `**[${escapeText(post.author.name)}](${post.author.url})** @${post.author.handle}`;
  const body = postBody(post, translator);
  const header = new TextDisplayBuilder().setContent(
    body.length > 0 ? `${heading}\n${body}` : heading,
  );
  const footer = [
    statsLine(post, translator),
    `<t:${Math.floor(post.createdAt / 1000)}:f>`,
    translator.t('replies:social_link_preview.post_view_original', { url: post.url }),
  ]
    .filter((part) => part.length > 0)
    .join(' · ');

  const container = new ContainerBuilder().setAccentColor(SOCIAL_COLORS.x);
  const avatar = post.author.avatarUrl;
  if (isHttps(avatar)) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(header)
        .setThumbnailAccessory((thumbnail) => thumbnail.setURL(avatar)),
    );
  } else {
    container.addTextDisplayComponents(header);
  }
  return container
    .addMediaGalleryComponents(new MediaGalleryBuilder().addItems((item) => item.setURL(videoUrl)))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${footer}`));
};

/**
 * The encodings worth downloading, best first: those whose estimated size
 * (bitrate × duration) fits under `maxBytes`, at most
 * {@link MAX_VIDEO_ATTEMPTS}. The downloader still enforces the real cap.
 * Exported for tests.
 */
export const pickVideoVariants = (
  video: NonNullable<SocialPost['video']>,
  maxBytes: number,
): PostVideoVariant[] =>
  video.variants
    .filter((variant) => (variant.bitrate * video.durationSeconds) / 8 <= maxBytes * SIZE_MARGIN)
    .slice(0, MAX_VIDEO_ATTEMPTS);
