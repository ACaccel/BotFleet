import type { ChatInputCommandInteraction } from 'discord.js';

import type { BaseBot } from '@bot';
import { bindTranslator } from '../../../core/i18n';
import { JobManager, parseDuration } from '@core/scheduling';
import {
  activityAnnouncement,
  activityJobKey,
  deleteActivity,
  findActivity,
  runActivityRollUp,
} from '../../../application/activity/activity';
import { buildActivityDepsFromBot } from './deps-from-bot';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { getOptionalString, getRequiredString } from '../../../infra/discord/options';

export const handleActivityCreate = async (
  interaction: ChatInputCommandInteraction,
  bot: BaseBot,
): Promise<void> => {
  await interaction.deferReply();
  const t = bindTranslator(bot.translator);
  const deps = buildActivityDepsFromBot(bot);
  try {
    // `title` and `duration` are declared `required: true`, so an
    // absent value is a contract violation the accessor raises and
    // the error boundary answers with a trace id.
    const title = getRequiredString(interaction, 'title');
    const duration = getRequiredString(interaction, 'duration');
    const description = getOptionalString(interaction, 'description');

    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply({ content: t('errors:command.guild_not_found') });
      return;
    }

    const channel = interaction.channel;
    if (!channel?.isSendable()) {
      await interaction.editReply({ content: t('errors:command.channel_not_sendable') });
      return;
    }

    const repos = deps.registry.getRepos(guild.id);
    if (!repos) {
      await interaction.editReply({ content: t('errors:db.not_found') });
      return;
    }

    const durationMs = parseDuration(duration);
    if (durationMs === null) {
      await interaction.editReply({ content: t('replies:activity.invalid_duration') });
      return;
    }

    const current_time = Date.now();
    const end_time = current_time + durationMs;
    const end_time_date = new Date(end_time);

    const activity_id = current_time.toString();
    const message_id = await activityAnnouncement(
      activity_id,
      channel,
      title,
      description || t('replies:common.empty_value'),
      end_time_date,
      deps,
    );
    if (!message_id) {
      await interaction.editReply({ content: t('replies:activity.create_announce_failed') });
      return;
    }

    // `create` returns Result<ActivityDoc, DatabaseError>. An
    // `err` is re-thrown into the surrounding catch.
    const createResult = await repos.activity.create({
      activity_id,
      message_id,
      title,
      description: description || '',
      expired_at: end_time,
      channel_id: channel.id,
      participants: [],
    });
    if (!createResult.ok) throw createResult.error;

    if (await findActivity(deps, guild.id, activity_id)) {
      new JobManager(deps.jobMap, deps.logger).schedule(
        activityJobKey(activity_id),
        end_time_date,
        () => runActivityRollUp(deps, guild.id, activity_id),
      );
    }

    await interaction.editReply({
      content: t('replies:activity.create_success', {
        activityId: activity_id,
        endTime: end_time_date.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
      }),
    });
  } catch (error) {
    await replyForError(interaction, bot, error, 'replies:activity.failed', interaction.guild?.id);
  }
};

export const handleActivityDelete = async (
  interaction: ChatInputCommandInteraction,
  bot: BaseBot,
): Promise<void> => {
  await interaction.deferReply();
  const t = bindTranslator(bot.translator);
  const deps = buildActivityDepsFromBot(bot);
  try {
    const activity_id = getRequiredString(interaction, 'activity_id');

    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply({ content: t('errors:command.guild_not_found') });
      return;
    }

    const outcome = await deleteActivity(deps, guild.id, activity_id);
    switch (outcome.status) {
      case 'deleted':
        await interaction.editReply({ content: t('replies:activity.delete_success') });
        return;
      case 'guild_not_found':
        await interaction.editReply({ content: t('errors:command.guild_not_found') });
        return;
      case 'no_db':
        await interaction.editReply({ content: t('errors:db.not_found') });
        return;
      default: {
        // Compile-time exhaustiveness guard: a new
        // DeleteActivityOutcome variant must be mapped above.
        const _exhaustive: never = outcome;
        return _exhaustive;
      }
    }
  } catch (error) {
    await replyForError(interaction, bot, error, 'replies:activity.failed', interaction.guild?.id);
  }
};
