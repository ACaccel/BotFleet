/**
 * The picture sources `/traffic` draws with: one shared Discord CDN loader per
 * process (its cache and concurrency cap are process-wide), and a single warning
 * when the colour emoji font cannot be used, after which Unicode emoji are left
 * out of the images.
 */
import type { Logger } from '@core/logger';

import { ops } from '../../../core/logger';
import { canvasEmojiAvailable } from '../../../infra/graphics/canvas-emoji';
import { createImageLoader, type RemoteImageLoader } from '../../../infra/graphics/image-loader';

let loader: RemoteImageLoader | undefined;
let emojiFontChecked = false;

export const trafficImageLoader = (logger: Logger | undefined): RemoteImageLoader => {
  loader ??= createImageLoader({ ...(logger === undefined ? {} : { logger }) });
  return loader;
};

export const warnOnceWithoutEmojiFont = (logger: Logger | undefined): void => {
  if (emojiFontChecked) return;
  emojiFontChecked = true;
  if (!canvasEmojiAvailable()) logger?.warn(ops.graphics.emojiFontUnavailable());
};
