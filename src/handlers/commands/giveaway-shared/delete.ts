import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';

import type { BaseBot } from '@bot';
import { bindTranslator } from '../../../core/i18n';
import { deleteGiveaway } from '../../../application/giveaway/giveaway';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { databaseUnavailableMessage } from './common';
import { buildGiveawayDepsFromBot } from './deps-from-bot';
import { buildGiveawayDeleteRows, cancelAuthority } from './delete-rows';

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
    const mayCancel = cancelAuthority(interaction, bot);
    const giveaways = listResult.value.filter((g) => mayCancel(g.prize_owner_id));

    if (giveaways.length === 0) {
      await interaction.editReply({ content: t('replies:giveaway.no_active_giveaways') });
      return;
    }

    await interaction.editReply({
      content: t('replies:giveaway.delete_select_placeholder'),
      components: buildGiveawayDeleteRows(giveaways, t, bot),
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

    const outcome = await deleteGiveaway(
      deps,
      guild.id,
      message_id,
      cancelAuthority(interaction, bot),
    );
    switch (outcome.status) {
      case 'deleted':
        await interaction.editReply({ content: t('replies:giveaway.delete_success') });
        return;
      case 'giveaway_not_found':
        await interaction.editReply({ content: t('replies:giveaway.delete_not_found') });
        return;
      case 'forbidden':
        await interaction.editReply({ content: t('replies:giveaway.delete_forbidden') });
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
