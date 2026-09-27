import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createCanvas, registerFont } from 'canvas';

const CANVAS_FONT_FAMILY = 'BotFleet CJK';
export const canvasFont = (size: number, bold = false): string =>
  `${bold ? 'bold ' : ''}${size}px "${CANVAS_FONT_FAMILY}"`;

let registered = false;

/** Register the font shipped in the selected Conda runtime before drawing text. */
export const ensureCanvasFont = (): void => {
  if (registered) return;
  const fontPath = join(dirname(process.execPath), '..', 'fonts', 'NotoSansCJKtc-VF.ttf');
  if (!existsSync(fontPath)) {
    throw new Error(`Missing Canvas CJK font: ${fontPath}. Run bash scripts/setup-env.sh.`);
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
    throw new Error(`Canvas CJK font cannot render distinct Chinese glyphs: ${fontPath}`);
  }
  registered = true;
};
