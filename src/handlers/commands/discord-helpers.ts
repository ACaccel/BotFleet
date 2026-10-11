import type { Message } from 'discord.js';
import { ButtonStyle } from 'discord.js';
import { ActionRowBuilder, ButtonBuilder } from '@discordjs/builders';
import schedule from 'node-schedule';
import type { Job } from 'node-schedule';
import type { Logger } from '@core/logger';

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
