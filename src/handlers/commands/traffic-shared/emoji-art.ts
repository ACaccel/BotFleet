/**
 * Emoji for the dashboards and embed text. A custom emoji is drawn from its
 * Discord CDN picture, a Unicode emoji from the colour emoji font; when neither
 * is available the dashboard draws the custom emoji's `:name:` and drops a
 * Unicode emoji rather than draw an empty box.
 */
import { renderEmojiImage } from '../../../infra/graphics/canvas-emoji';
import type { RemoteImageLoader } from '../../../infra/graphics/image-loader';

import type { EmojiToken } from './dashboard';

/** Square size of a decoded emoji picture; the dashboards scale it down. */
const EMOJI_IMAGE_PX = 48;

/** A reaction or emoji as the statistics reader reports it. */
export interface EmojiRef {
  /** Custom emoji ID, or the Unicode emoji itself. */
  readonly key: string;
  readonly emojiId?: string;
  readonly name?: string;
  readonly animated?: boolean;
}

/** CDN URL of a custom emoji's still picture. */
export const customEmojiUrl = (emojiId: string): string =>
  `https://cdn.discordapp.com/emojis/${emojiId}.png?size=64`;

export const customEmojiLabel = (name: string | undefined): string => `:${name ?? '?'}:`;

export const emojiToken = async (ref: EmojiRef, loader: RemoteImageLoader): Promise<EmojiToken> => {
  if (ref.emojiId !== undefined)
    return {
      image: await loader.load(customEmojiUrl(ref.emojiId)),
      fallback: customEmojiLabel(ref.name),
    };
  return { image: renderEmojiImage(ref.key, EMOJI_IMAGE_PX), fallback: ref.key };
};

/** Embed markdown for an emoji: `<:name:id>` for a custom one, the character otherwise. */
export const emojiMarkdown = (ref: EmojiRef): string =>
  ref.emojiId === undefined
    ? ref.key
    : `<${ref.animated === true ? 'a' : ''}:${ref.name ?? '_'}:${ref.emojiId}>`;
