import type { Message } from 'discord.js';
import { AttachmentBuilder, ButtonStyle } from 'discord.js';
import { ActionRowBuilder, ButtonBuilder } from '@discordjs/builders';
import { createCanvas, loadImage } from 'canvas';
import schedule from 'node-schedule';
import type { Job } from 'node-schedule';
import type { Logger } from '@core/logger';
import { canvasFont, ensureCanvasFont } from '../../infra/graphics/canvas-font';

import { boundedHttp } from '../../infra/http';

/**
 * Shared Discord-side helpers for command handlers.
 *
 * Grouped here because every consumer is a `src/handlers/commands/*`
 * handler at runtime.
 */

/** Discord caps a message component action row at five buttons. */
const MAX_BUTTONS_PER_ROW = 5;

interface ButtonConfig {
  customId: string;
  label: string;
  style?: ButtonStyle;
}

/**
 * Build action rows from a flat list of button configs, packing up to
 * {@link MAX_BUTTONS_PER_ROW} buttons per row as Discord requires.
 */
export const buildButtonRows = (
  buttonConfig: ButtonConfig[],
): ActionRowBuilder<ButtonBuilder>[] => {
  const buttons: ButtonBuilder[] = buttonConfig.map((button) =>
    new ButtonBuilder()
      .setCustomId(button.customId)
      .setLabel(button.label)
      .setStyle(button.style ?? ButtonStyle.Primary),
  );

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += MAX_BUTTONS_PER_ROW) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        buttons.slice(i, i + MAX_BUTTONS_PER_ROW),
      ),
    );
  }

  return rows;
};

/**
 * React to `msg` with each emoji in `reactions`, in order.
 *
 * Per-reaction failures are isolated so one rejected `react()` does not
 * abort the rest. When a `logger` is supplied the failure is recorded on
 * the structured operator channel; without one it is silently skipped.
 */
export const msgReact = async (
  msg: Message,
  reactions: string[],
  logger?: Logger,
  clientId?: string,
): Promise<void> => {
  if (!msg || !reactions || reactions.length === 0) return;

  for (const reaction of reactions) {
    try {
      await msg.react(reaction);
    } catch (error) {
      logger
        ?.child({ bot: clientId ?? 'unknown', guildId: msg.guildId ?? undefined })
        .error({ err: error, messageId: msg.id, reaction }, 'msgReact: failed to add reaction');
    }
  }
};

/**
 * Schedule a one-shot callback to run at `date`.
 *
 * A thin pass-through to `node-schedule` for handlers that do not need
 * the keyed lifecycle of `core/scheduling`'s `JobManager`.
 */
export const scheduleJob = (date: Date, callback: () => void): Job =>
  schedule.scheduleJob(date, callback);

/** Layout knobs for {@link listInOneImage}. */
interface CanvasOptions {
  itemsPerRow: number;
  itemSize: number;
  padding: number;
  textHeight: number;
}

/** One labelled image tile rendered by {@link listInOneImage}. */
export interface CanvasContent {
  url: string;
  text: string;
}

const DEFAULT_CANVAS_OPTIONS: CanvasOptions = {
  itemsPerRow: 5,
  itemSize: 100,
  padding: 20,
  textHeight: 30,
};

/**
 * Render a grid of remote images with captions into a single PNG
 * attachment. Returns `null` when `content` is empty.
 *
 * Images that fail to download are drawn as a neutral placeholder tile
 * so a single bad URL does not fail the whole grid.
 */
export const listInOneImage = async (
  content: CanvasContent[],
  options?: Partial<CanvasOptions>,
): Promise<AttachmentBuilder | null> => {
  if (content.length === 0) return null;
  ensureCanvasFont();

  const { itemsPerRow, itemSize, padding, textHeight } = {
    ...DEFAULT_CANVAS_OPTIONS,
    ...options,
  };

  const canvasWidth = itemsPerRow * (itemSize + padding) + padding;
  const rows = Math.ceil(content.length / itemsPerRow);
  const canvasHeight = rows * (itemSize + textHeight + padding) + padding;

  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d');

  // Background.
  ctx.fillStyle = '#2f3136';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let i = 0; i < content.length; i++) {
    const item = content[i];
    if (item === undefined) continue;
    const { url, text } = item;
    const row = Math.floor(i / itemsPerRow);
    const col = i % itemsPerRow;
    const x = col * (itemSize + padding) + padding;
    const y = row * (itemSize + textHeight + padding) + padding;

    try {
      const response = await boundedHttp.get<ArrayBuffer>(url, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data);
      const img = await loadImage(buffer);
      ctx.drawImage(img, x, y, itemSize, itemSize);
    } catch {
      // Draw a placeholder if the image fails to load.
      ctx.fillStyle = '#40444b';
      ctx.fillRect(x, y, itemSize, itemSize);
    }
    ctx.fillStyle = '#ffffff';
    ctx.font = canvasFont(16);
    ctx.textAlign = 'center';
    ctx.fillText(text, x + itemSize / 2, y + itemSize + 20);
  }

  const buffer = canvas.toBuffer('image/png');
  return new AttachmentBuilder(buffer, { name: 'listInOneImage.png' });
};
