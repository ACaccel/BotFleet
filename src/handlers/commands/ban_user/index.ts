import type { ChatInputCommandInteraction, GuildMember } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';
import { msgReact, scheduleJob } from '../discord-helpers';

import { logError } from '@core/logger';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { getOptionalNumber, getRequiredString } from '../../../infra/discord/options';
import { buildVoteMessage } from './vote-message';
import { judgeVote } from './judgement';
import { ancestorChannelIdsOf } from '../../../infra/discord';
export default class ban_user extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'ban_user',
      category: 'fun',
      guildOnly: true,
      options: {
        user: [
          {
            name: 'user',
            required: true,
          },
        ],
        integer: [{ name: 'duration', required: false, min: 1, max: 5 }],
      },
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply();
    try {
      const settings = bot.guildSettings;
      // Copy so a running poll keeps its starting parameters after later saves.
      const current = interaction.guildId
        ? settings?.get(interaction.guildId)?.settings.moderationVote
        : undefined;
      const preferences = current ? structuredClone(current) : undefined;
      const voteEnabled = (): boolean =>
        !settings ||
        (interaction.guildId !== null &&
          JSON.stringify(
            settings.get(interaction.guildId)?.settings.moderationVote.voterRoleIds.slice().sort(),
          ) === JSON.stringify(preferences?.voterRoleIds.slice().sort()) &&
          settings.isEnabled(
            interaction.guildId,
            'moderation_vote',
            interaction.channelId,
            ancestorChannelIdsOf(interaction.channel, interaction.guild?.channels.cache),
          ));
      if (settings && (!preferences || !voteEnabled())) {
        await interaction.editReply({
          content: bot.translator?.t('replies:ban_user.vote_cancelled') ?? '',
        });
        return;
      }
      const threshold = preferences?.threshold ?? 5;
      const voteWindowSeconds = preferences?.voteWindowSeconds ?? 60;
      const user = getRequiredString(interaction, 'user');
      const member = interaction.guild?.members.cache.get(user);
      const voterRoleId = bot.getGuildInfo(interaction.guild?.id as string)?.roles?.ban_user?.id;
      if (!member) {
        await interaction.editReply({
          content: bot.translator?.t('errors:command.user_not_found') ?? '',
        });
        return;
      }
      if (member.user.bot) {
        await interaction.editReply({
          content: bot.translator?.t('replies:ban_user.cannot_ban_bot') ?? '',
        });
        return;
      }

      if (settings && !member.moderatable) {
        await interaction.editReply({
          content: bot.translator?.t('replies:ban_user.target_ineligible') ?? '',
        });
        return;
      }

      // Discord bounds the option to 1-5; clamp again for direct API calls.
      const duration = Math.min(
        5,
        Math.max(
          1,
          getOptionalNumber(interaction, 'duration') ?? preferences?.durationMinutes ?? 1,
        ),
      );

      const initiator = (interaction.member as GuildMember) || interaction.user;
      await interaction.deleteReply();
      const ch = interaction.channel;
      if (!ch?.isSendable()) return;
      const judge_msg = await ch.send(
        buildVoteMessage(bot.translator, {
          initiator: initiator.displayName,
          target: member.displayName,
          duration,
          judgeTime: voteWindowSeconds / 60,
          judgeSeconds: preferences ? voteWindowSeconds : undefined,
          threshold,
          voterRoleId: preferences ? undefined : voterRoleId,
          voterRoleIds: preferences?.voterRoleIds,
          flavor: bot.voteFlavor,
        }),
      );
      await msgReact(judge_msg, ['👍'], bot.logger, bot.clientId);

      // judgement time
      const current_time = Date.now();
      const end_time = current_time + voteWindowSeconds * 1000;
      const end_time_date = new Date(end_time);

      const ban_judgement = () =>
        judgeVote({
          bot,
          guild: interaction.guild,
          judgeMessage: judge_msg,
          member,
          enforced: settings !== undefined,
          voterRoleIds: preferences?.voterRoleIds,
          threshold,
          duration,
          voteEnabled,
        });
      // node-schedule discards the value its callback returns, so the
      // rejection has to be caught here or it escapes as a detached
      // unhandledRejection with no link back to this vote.
      scheduleJob(end_time_date, () => {
        void ban_judgement().catch((err: unknown) =>
          logError(bot.logger, interaction.guild?.id, err),
        );
      });
    } catch (error) {
      await replyForError(
        interaction,
        bot,
        error,
        'replies:ban_user.failed',
        interaction.guild?.id,
      );
    }
  }
}
