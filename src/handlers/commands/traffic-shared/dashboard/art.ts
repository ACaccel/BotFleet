/**
 * Emoji, sticker, and application art: the preloaded image when it is
 * drawable, else a coloured placeholder tile so a failed CDN download
 * never fails the whole dashboard.
 */
import type { Image } from 'canvas';

import { roundRect } from '../canvas-primitives';
import type { Ctx } from './layout';
import { drawImageFit, isDrawable } from './image';
import { drawText } from './text';
import { COLOR, hueFor } from './theme';

export interface Art {
  readonly image: Image | null;
  /** Seeds the placeholder colour. */
  readonly name: string;
  /** Short text drawn on the placeholder. */
  readonly initials: string;
}

/** Preloaded art when drawable, else a coloured tile with short initials. */
export const drawArt = (
  ctx: Ctx,
  art: Art,
  x: number,
  y: number,
  size: number,
  radius: number,
): void => {
  if (isDrawable(art.image)) {
    drawImageFit(ctx, art.image, x, y, size, size);
    return;
  }
  const hue = hueFor(art.name);
  roundRect(ctx, x, y, size, size, radius);
  ctx.fillStyle = `hsl(${hue},42%,40%)`;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size * 0.34, 0, Math.PI * 2);
  ctx.fillStyle = `hsl(${hue},45%,52%)`;
  ctx.fill();
  drawText(ctx, art.initials, x + size / 2, y + size / 2 + 1, {
    size: Math.round(size * 0.36),
    color: COLOR.white,
    bold: true,
    align: 'center',
  });
};
