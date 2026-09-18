import {
  ActionRowBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';

import { asGuildId } from '../../../core/ids';
import type { BaseBot } from '../../../bot';
import { bindTranslator } from '../../../core/i18n';
import type { BoundTranslate } from '../../../core/i18n';
import { logError } from '../../../core/logger';
import { JobManager, parseDuration } from '@core/scheduling';
import {
  deleteGiveaway,
  findGiveaway,
  giveawayAnnouncement,
  giveawayJobKey,
  runGiveawayDraw,
} from './giveaway';
import type { GiveawayDoc } from '../../../persistence/schemas/giveaway.schema';
import { buildGiveawayDepsFromBot } from './deps-from-bot';
import { replyForError } from '../../../infra/discord/reply-for-error';

// Discord allows at most 25 options per string-select and 5 selects per
// message, so the delete prompt pages giveaways across multiple selects
// instead of silently dropping any past the first 25.
const databaseUnavailableMessage = (bot: BaseBot, guildId: string, t: BoundTranslate): string => {
  const disabled = bot.connectionManager?.isDisabled(asGuildId(guildId));
  return disabled === undefined
    ? t('errors:db.not_found')
    : t('errors:db.guild_disabled', { traceId: disabled.traceId });
};

const MAX_OPTIONS_PER_SELECT = 25;
// Discord caps a select-option label at 100 chars; keep the prize short
// enough that the formatted "<prize> — ends at <time>" label still fits.
const MAX_PRIZE_LABEL_LENGTH = 50;
const TAIPEI_LOCALE = 'zh-TW';
const TAIPEI_TIME_ZONE = 'Asia/Taipei';

export const handleGiveawayCreate = async (
  interaction: ModalSubmitInteraction,
  bot: BaseBot,
): Promise<void> => {
  // Reply ephemerally so the acknowledgement (and any validation
  // error) is visible only to the invoker. On the success path the
  // deferred reply is deleted, leaving the announcement embed as the
  // only visible output.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const t = bindTranslator(bot.translator);
  const deps = buildGiveawayDepsFromBot(bot);
  try {
    // Modal fields are always strings; trim and validate here since
    // the modal has no numeric input type.
    const duration = interaction.fields.getTextInputValue('duration').trim();
    const winnerRaw = interaction.fields.getTextInputValue('winner_num').trim();
    const prize = interaction.fields.getTextInputValue('prize').trim();
    const description = interaction.fields.getTextInputValue('description').trim();

    if (!duration || !winnerRaw || !prize) {
      await interaction.editReply({ content: t('replies:giveaway.missing_required_fields') });
      return;
    }

    // `Number(...)` (not parseInt) so trailing junk like "3abc" is
    // rejected rather than silently coerced to 3.
    const winner_num = Number(winnerRaw);
    if (!Number.isInteger(winner_num) || winner_num <= 0) {
      await interaction.editReply({ content: t('replies:giveaway.invalid_winner_num') });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply({ content: t('errors:command.guild_not_found') });
      return;
    }

    // Preserve the selected destination across the modal submission.
    const useConfiguredChannel = interaction.customId === 'giveaway_create|configured';
    const channel = useConfiguredChannel
      ? deps.registry.getChannel(guild.id, 'giveaway')
      : interaction.channel;
    if (!channel?.isSendable()) {
      await interaction.editReply({ content: t('errors:command.channel_not_found') });
      return;
    }

    const repos = deps.registry.getRepos(guild.id);
    if (!repos) {
      await interaction.editReply({ content: databaseUnavailableMessage(bot, guild.id, t) });
      return;
    }

    const durationMs = parseDuration(duration);
    if (durationMs === null) {
      await interaction.editReply({ content: t('replies:giveaway.invalid_duration') });
      return;
    }

    const current_time = Date.now();
    const end_time = current_time + durationMs;
    const end_time_date = new Date(end_time);

    const message_id = await giveawayAnnouncement(
      channel,
      prize,
      interaction.user.id,
      winner_num,
      end_time_date,
      description || t('replies:common.empty_value'),
      deps,
    );
    if (!message_id) {
      await interaction.editReply({ content: t('replies:giveaway.create_announce_failed') });
      return;
    }

    // `create` returns Result<GiveawayDoc, DatabaseError>. An
    // `err` is re-thrown into the surrounding catch. `channel_id`
    // records the announcement channel so the reboot path
    // (`scheduleGiveaway`) re-resolves the same channel when it
    // announces the result.
    const createResult = await repos.giveaway.create({
      winner_num,
      prize,
      end_time,
      channel_id: channel.id,
      prize_owner_id: interaction.user.id,
      participants: [],
      message_id,
    });
    if (!createResult.ok) throw createResult.error;

    if (await findGiveaway(deps, guild.id, message_id)) {
      new JobManager(deps.jobMap, deps.logger).schedule(
        giveawayJobKey(message_id),
        end_time_date,
        () => runGiveawayDraw(deps, guild.id, message_id),
      );
    }

    // No success reply — the announcement embed is the only
    // intended output, so remove the ephemeral acknowledgement.
    await interaction.deleteReply();
  } catch (error) {
    logError(bot.logger, interaction.guild?.id ?? null, error);
    await interaction.editReply({ content: t('replies:giveaway.create_failed') });
  }
};

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
