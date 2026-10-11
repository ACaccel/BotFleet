import {
  ActionRowBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';

import type { BaseBot } from '@bot';
import { bindTranslator } from '../../../core/i18n';
import type { BoundTranslate } from '../../../core/i18n';
import { deleteGiveaway } from '../../../application/giveaway/giveaway';
import type { GiveawayDoc } from '../../../persistence/schemas/giveaway.schema';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { databaseUnavailableMessage } from './common';
import { buildGiveawayDepsFromBot } from './deps-from-bot';

// Discord allows at most 25 options per string-select and 5 selects per
// message, so the delete prompt pages giveaways across multiple selects
// instead of silently dropping any past the first 25.
const MAX_OPTIONS_PER_SELECT = 25;
// Discord caps a select-option label at 100 chars; keep the prize short
// enough that the formatted "<prize> — ends at <time>" label still fits.
const MAX_PRIZE_LABEL_LENGTH = 50;
const TAIPEI_LOCALE = 'zh-TW';
const TAIPEI_TIME_ZONE = 'Asia/Taipei';

/**
 * Build the paged string-select rows offering each active giveaway as
 * a delete target. Each row carries a distinct `customId` page suffix
 * because Discord requires unique component ids within a message; the
 * select handler only reads the selected value (the message id).
 */
const buildGiveawayDeleteRows = (
  giveaways: readonly GiveawayDoc[],
  t: BoundTranslate,
): ActionRowBuilder<StringSelectMenuBuilder>[] => {
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
          const endTime = new Date(g.end_time).toLocaleString(TAIPEI_LOCALE, {
            timeZone: TAIPEI_TIME_ZONE,
          });
          return new StringSelectMenuOptionBuilder()
            .setLabel(t('replies:giveaway.delete_option_label', { prize, endTime }).slice(0, 100))
            .setValue(g.message_id);
        }),
      );
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  }
  return rows;
};

export const handleGiveawayDeletePrompt = async (
  interaction: ChatInputCommandInteraction,
  bot: BaseBot,
): Promise<void> => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const t = bindTranslator(bot.translator);
  const deps = buildGiveawayDepsFromBot(bot);
  try {
    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply({ content: t('errors:command.guild_not_found') });
      return;
    }

    const repos = deps.registry.getRepos(guild.id);
    if (!repos) {
      await interaction.editReply({ content: databaseUnavailableMessage(bot, guild.id, t) });
      return;
    }

    // listAll returns Result<T, DatabaseError>. An `err` is
    // re-thrown into the surrounding catch.
    const listResult = await repos.giveaway.listAll();
    if (!listResult.ok) throw listResult.error;
    const giveaways = listResult.value;

    if (giveaways.length === 0) {
      await interaction.editReply({ content: t('replies:giveaway.no_active_giveaways') });
      return;
    }

    await interaction.editReply({
      content: t('replies:giveaway.delete_select_placeholder'),
      components: buildGiveawayDeleteRows(giveaways, t),
    });
  } catch (error) {
    await replyForError(interaction, bot, error, 'replies:giveaway.failed', interaction.guild?.id);
  }
};

export const handleGiveawayDeleteSelection = async (
  interaction: StringSelectMenuInteraction,
  bot: BaseBot,
): Promise<void> => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const t = bindTranslator(bot.translator);
  const deps = buildGiveawayDepsFromBot(bot);
  try {
    const message_id = interaction.values[0];
    if (!message_id) {
      await interaction.editReply({ content: t('replies:giveaway.missing_message_id') });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply({ content: t('errors:command.guild_not_found') });
      return;
    }

    const outcome = await deleteGiveaway(deps, guild.id, message_id);
    switch (outcome.status) {
      case 'deleted':
        await interaction.editReply({ content: t('replies:giveaway.delete_success') });
        return;
      case 'guild_not_found':
        await interaction.editReply({ content: t('errors:command.guild_not_found') });
        return;
      case 'no_db':
        await interaction.editReply({ content: databaseUnavailableMessage(bot, guild.id, t) });
        return;
      default: {
        // Compile-time exhaustiveness guard: a new
        // DeleteGiveawayOutcome variant must be mapped above.
        const _exhaustive: never = outcome;
        return _exhaustive;
      }
    }
  } catch (error) {
    await replyForError(interaction, bot, error, 'replies:giveaway.failed', interaction.guild?.id);
  }
};
