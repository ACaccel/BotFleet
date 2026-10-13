import {
  ActionRowBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';

import type { BaseBot } from '@bot';
import type { BoundTranslate } from '../../../core/i18n';
import type { GiveawayDoc } from '../../../persistence/schemas/giveaway.schema';

// Discord allows at most 25 options per string-select and 5 selects per
// message, so the delete prompt pages giveaways across multiple selects
// instead of silently dropping any past the first 25.
const MAX_OPTIONS_PER_SELECT = 25;
// Discord caps a select-option label at 100 chars; keep the prize short
// enough that the formatted "<prize> — ends at <time>" label still fits.
const MAX_PRIZE_LABEL_LENGTH = 50;

/**
 * Whether the requester may cancel a giveaway owned by `ownerId`: its
 * creator, a member who moderates messages or events, or a bot admin.
 */
export const cancelAuthority =
  (interaction: ChatInputCommandInteraction | StringSelectMenuInteraction, bot: BaseBot) =>
  (ownerId: string): boolean =>
    ownerId === interaction.user.id ||
    bot.isAdmin(interaction.user.id) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) === true ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents) === true;

/**
 * Build the paged string-select rows offering each active giveaway as
 * a delete target. Each row carries a distinct `customId` page suffix
 * because Discord requires unique component ids within a message; the
 * select handler only reads the selected value (the message id).
 */
export const buildGiveawayDeleteRows = (
  giveaways: readonly GiveawayDoc[],
  t: BoundTranslate,
  bot: BaseBot,
): ActionRowBuilder<StringSelectMenuBuilder>[] => {
  // Select labels cannot render Discord timestamps, so format in the bot's zone.
  const formatEnd = new Intl.DateTimeFormat(bot.config.language ?? 'zh-TW', {
    timeZone: bot.timeZone,
    dateStyle: 'short',
    timeStyle: 'short',
  });
  const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
  for (let i = 0; i < giveaways.length; i += MAX_OPTIONS_PER_SELECT) {
    const page = i / MAX_OPTIONS_PER_SELECT;
    const select = new StringSelectMenuBuilder()
      .setCustomId(`giveaway_delete|${page}`)
      .setPlaceholder(t('replies:giveaway.delete_select_placeholder'))
      .addOptions(
        giveaways.slice(i, i + MAX_OPTIONS_PER_SELECT).map((g) => {
          const prize =
            g.prize.length > MAX_PRIZE_LABEL_LENGTH
              ? `${g.prize.slice(0, MAX_PRIZE_LABEL_LENGTH)}…`
              : g.prize;
          const endTime = formatEnd.format(new Date(g.end_time));
          return new StringSelectMenuOptionBuilder()
            .setLabel(t('replies:giveaway.delete_option_label', { prize, endTime }).slice(0, 100))
            .setValue(g.message_id);
        }),
      );
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  }
  return rows;
};
