import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createCanvas, registerFont } from 'canvas';

import { ConfigurationError } from '../../core/errors';

const CANVAS_FONT_FAMILY = 'BotFleet CJK';
export const canvasFont = (size: number, bold = false): string =>
  `${bold ? 'bold ' : ''}${size}px "${CANVAS_FONT_FAMILY}"`;

let registered = false;

/** Path of a font file shipped in the selected Conda runtime's `fonts/` directory. */
export const condaFontPath = (file: string): string =>
  join(dirname(process.execPath), '..', 'fonts', file);

const fontUnavailable = (fontPath: string, reason: string): ConfigurationError =>
  new ConfigurationError({
    code: 'UNSUPPORTED_FEATURE',
    messageKey: 'errors:graphics.font_missing',
    context: { operation: 'ensureCanvasFont', input: { fontPath, reason } },
  });

/**
 * Register the font shipped in the selected Conda runtime before drawing text.
 * Setup and release preparation call it to reject a host without the font; a
 * chart render calls it again in case the runtime changed since.
 *
 * @throws {ConfigurationError} `UNSUPPORTED_FEATURE` when the font is missing or
 *   cannot draw Chinese glyphs; the host needs `bash scripts/setup-env.sh`.
 */
export const ensureCanvasFont = (): void => {
  if (registered) return;
  const fontPath = condaFontPath('NotoSansCJKtc-VF.ttf');
  if (!existsSync(fontPath)) {
    throw fontUnavailable(fontPath, 'missing; run bash scripts/setup-env.sh');
  }
  registerFont(fontPath, { family: CANVAS_FONT_FAMILY });

  // A successful registration does not prove that Pango can draw CJK glyphs.
  const canvas = createCanvas(40, 40);
  const ctx = canvas.getContext('2d');
  ctx.font = canvasFont(28);
  ctx.fillStyle = '#ffffff';
  ctx.fillText('\u4e2d', 0, 30);
  const first = ctx.getImageData(0, 0, 40, 40).data.slice();
  ctx.clearRect(0, 0, 40, 40);
  ctx.fillText('\u6587', 0, 30);
  const second = ctx.getImageData(0, 0, 40, 40).data;
  if (!first.some((value, index) => value !== second[index])) {
    throw fontUnavailable(fontPath, 'cannot render distinct Chinese glyphs');
  }
  registered = true;
};
