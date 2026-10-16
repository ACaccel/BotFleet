/**
 * Preloaded-image helpers. Callers pass a decoded canvas `Image` (a
 * Discord CDN download) or `null`; an image that failed to decode has a
 * zero size and is treated like `null`, so every drawing site falls back
 * to text or a placeholder instead of failing the whole dashboard.
 */
import type { Image } from 'canvas';

import type { Ctx } from './layout';

export const isDrawable = (image: Image | null): image is Image =>
  image !== null && image.width > 0 && image.height > 0;

/** Draw `image` centred inside the box, keeping its aspect ratio. */
export const drawImageFit = (
  ctx: Ctx,
  image: Image,
  x: number,
  y: number,
  w: number,
  h: number,
): void => {
  const ratio = Math.min(w / image.width, h / image.height);
  const dw = image.width * ratio;
  const dh = image.height * ratio;
  ctx.drawImage(image, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
};
