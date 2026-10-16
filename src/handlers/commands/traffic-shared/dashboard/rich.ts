/**
 * Builds `RichText` from one translated sentence, so translators keep the
 * whole sentence, including where the emoji sits, in a single catalog
 * string instead of callers splitting it into fragments.
 */
import type { EmojiToken, InlinePart, RichText } from './types-common';

/**
 * Placeholder for an emoji inside a translated sentence (U+FFFC OBJECT
 * REPLACEMENT CHARACTER); pass it as the interpolation value, e.g.
 * `t('key', { emoji: EMOJI_SLOT })`.
 */
export const EMOJI_SLOT = '\uFFFC';

/**
 * Split `text` on `EMOJI_SLOT` and fill the slots with `tokens` in order.
 * A slot without a token is dropped and extra tokens are ignored, so a
 * catalog string that lost its placeholder still renders its text.
 */
export const richFromTemplate = (text: string, tokens: readonly EmojiToken[]): RichText => {
  const pieces = text.split(EMOJI_SLOT);
  const parts: InlinePart[] = [];
  pieces.forEach((piece, i) => {
    if (piece.length > 0) parts.push(piece);
    const token = i < pieces.length - 1 ? tokens[i] : undefined;
    if (token !== undefined) parts.push(token);
  });
  return parts;
};
