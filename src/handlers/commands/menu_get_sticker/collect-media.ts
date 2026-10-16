import { StickerFormatType, type Collection, type Sticker } from 'discord.js';

/** One sticker or custom emoji the context menu can show. */
export interface MediaItem {
  readonly kind: 'sticker' | 'emoji';
  readonly name: string;
  readonly url: string;
  /** Lottie stickers are JSON animations Discord cannot show as an image. */
  readonly previewable: boolean;
}

/** Discord allows ten embeds per message. */
export const MAX_ITEMS = 10;

const CUSTOM_EMOJI = /<(a?):(\w+):(\d+)>/g;

/** Stickers first, then each distinct custom emoji in the text, in order of appearance. */
export const collectMedia = (
  stickers: Collection<string, Sticker>,
  content: string,
): MediaItem[] => {
  const items: MediaItem[] = [...stickers.values()].map((sticker) => ({
    kind: 'sticker',
    name: sticker.name,
    url: sticker.url,
    previewable: sticker.format !== StickerFormatType.Lottie,
  }));
  const seen = new Set<string>();
  for (const [, animated, name, id] of content.matchAll(CUSTOM_EMOJI)) {
    if (id === undefined || name === undefined || seen.has(id)) continue;
    seen.add(id);
    const extension = animated === 'a' ? 'gif' : 'png';
    items.push({
      kind: 'emoji',
      name,
      url: `https://cdn.discordapp.com/emojis/${id}.${extension}`,
      previewable: true,
    });
  }
  return items;
};
