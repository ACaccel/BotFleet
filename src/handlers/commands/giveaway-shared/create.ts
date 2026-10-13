import { MessageFlags, type ModalSubmitInteraction } from 'discord.js';

import type { BaseBot } from '@bot';
import { bindTranslator } from '../../../core/i18n';
import { logError } from '../../../core/logger';
import { JobManager, parseDuration } from '@core/scheduling';
import {
  findGiveaway,
  giveawayAnnouncement,
  giveawayJobKey,
  runGiveawayDraw,
} from '../../../application/giveaway/giveaway';
import { databaseUnavailableMessage } from './common';
import { buildGiveawayDepsFromBot } from './deps-from-bot';

const MIN_DURATION_MS = 60_000;
const MAX_DURATION_MS = 30 * 24 * 60 * 60_000;

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
    if (durationMs === null || durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) {
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
    if (!createResult.ok) {
      // Without a record the giveaway would never be drawn; withdraw it.
      await channel.messages.delete(message_id).catch(() => undefined);
      throw createResult.error;
    }

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
