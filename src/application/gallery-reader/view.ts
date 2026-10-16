/**
 * The gallery reader message: one embed showing the current page, either
 * from a URL staged ahead of time or as an attachment uploaded with the
 * message, and a row of paging buttons. The first page also
 * lists the gallery's tags, page count and favourites; later pages keep
 * only the title and position so the image stays the focus.
 */
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import type { BoundTranslate } from '../../core/i18n';
import { EMBED_COLORS } from '../../infra/discord/presentation-colors';
import type { Gallery, GallerySourceName } from '../../infra/link-preview';
import {
  encodeGalleryJumpButtonId,
  encodeGalleryJumpModalId,
  encodeGalleryPageButtonId,
  GALLERY_JUMP_INPUT_ID,
} from './custom-id';
import { galleryPageFileName, type GalleryPageMedia } from './service';

const SITE_LABELS: Readonly<Record<GallerySourceName, string>> = {
  nhentai: 'nhentai',
  wnacg: 'wnacg',
};
const MAX_TITLE = 256;
const MAX_DESCRIPTION = 512;
const MAX_FIELD = 1024;
const NO_MENTIONS = { parse: [] as const };

export interface GalleryMessage {
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<ButtonBuilder>[];
  readonly files: AttachmentBuilder[];
  readonly allowedMentions: typeof NO_MENTIONS;
}

const truncate = (text: string, max: number): string => {
  const characters = Array.from(text);
  return characters.length <= max ? text : `${characters.slice(0, max - 3).join('')}...`;
};

const button = (customId: string, emoji: string, disabled: boolean): ButtonBuilder =>
  new ButtonBuilder()
    .setCustomId(customId)
    .setStyle(ButtonStyle.Secondary)
    .setEmoji(emoji)
    .setDisabled(disabled);

const pagingRow = (gallery: Gallery, page: number): ActionRowBuilder<ButtonBuilder> => {
  const total = gallery.pages.length;
  const atStart = page <= 1;
  const atEnd = page >= total;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    button(encodeGalleryPageButtonId(gallery, 1, 'f'), '⏮️', atStart),
    button(encodeGalleryPageButtonId(gallery, Math.max(page - 1, 1), 'p'), '◀️', atStart),
    new ButtonBuilder()
      .setCustomId(encodeGalleryJumpButtonId(gallery, total))
      .setStyle(ButtonStyle.Primary)
      .setLabel(`${page} / ${total}`)
      .setDisabled(total <= 1),
    button(encodeGalleryPageButtonId(gallery, Math.min(page + 1, total), 'n'), '▶️', atEnd),
    button(encodeGalleryPageButtonId(gallery, total, 'l'), '⏭️', atEnd),
  );
};

export const buildGalleryMessage = (
  gallery: Gallery,
  page: number,
  media: GalleryPageMedia,
  t: BoundTranslate,
): GalleryMessage => {
  const upload =
    media.kind === 'file'
      ? new AttachmentBuilder(media.image.data, {
          name: galleryPageFileName(gallery, page, media.image),
        })
      : undefined;
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLORS.info)
    .setTitle(truncate(gallery.title, MAX_TITLE))
    .setURL(gallery.url)
    .setImage(media.kind === 'url' ? media.url : `attachment://${upload?.name ?? ''}`)
    .setFooter({
      text: t('replies:gallery_preview.footer', {
        site: SITE_LABELS[gallery.source],
        id: gallery.id,
        page,
        total: gallery.pages.length,
      }),
    });
  if (page === 1) {
    if (gallery.subtitle !== undefined) {
      embed.setDescription(truncate(gallery.subtitle, MAX_DESCRIPTION));
    }
    embed.addFields(
      ...gallery.tags.map((group) => ({
        name: t(`replies:gallery_preview.tag_types.${group.type}`),
        value: truncate(group.names.join(', '), MAX_FIELD),
      })),
      {
        name: t('replies:gallery_preview.pages'),
        value: String(gallery.pages.length),
        inline: true,
      },
      ...(gallery.favorites === undefined
        ? []
        : [
            {
              name: t('replies:gallery_preview.favorites'),
              value: String(gallery.favorites),
              inline: true,
            },
          ]),
    );
  }
  return {
    embeds: [embed],
    components: [pagingRow(gallery, page)],
    files: upload === undefined ? [] : [upload],
    allowedMentions: NO_MENTIONS,
  };
};

/** The jump form, opened from the page-position button. */
export const buildGalleryJumpModal = (
  target: Pick<Gallery, 'source' | 'id'>,
  total: number,
  t: BoundTranslate,
): ModalBuilder =>
  new ModalBuilder()
    .setCustomId(encodeGalleryJumpModalId(target))
    .setTitle(t('replies:gallery_preview.jump_title'))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(GALLERY_JUMP_INPUT_ID)
          .setLabel(t('replies:gallery_preview.jump_label', { total }))
          .setStyle(TextInputStyle.Short)
          .setMinLength(1)
          .setMaxLength(4)
          .setRequired(true),
      ),
    );
