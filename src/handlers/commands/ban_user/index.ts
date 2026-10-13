import type { ChatInputCommandInteraction, GuildMember } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';
import { msgReact, scheduleJob } from '../discord-helpers';

import { logError } from '@core/logger';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { getOptionalNumber, getRequiredString } from '../../../infra/discord/options';
import { startMessageDeletionFallback } from './delete-messages-fallback';
import { buildVoteMessage } from './vote-message';
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
      const BAN_THRESHOLD = 5; // number of votes required to ban
      const JUDGE_TIME = 1; // minutes to judge
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

      // Discord bounds the option to 1-5; clamp again for direct API calls.
      const duration = Math.min(5, Math.max(1, getOptionalNumber(interaction, 'duration') ?? 1));

      const initiator = (interaction.member as GuildMember) || interaction.user;
      await interaction.deleteReply();
      const ch = interaction.channel;
      if (!ch?.isSendable()) return;
      const judge_msg = await ch.send(
        buildVoteMessage(bot.translator, {
          initiator: initiator.displayName,
          target: member.displayName,
          duration,
          judgeTime: JUDGE_TIME,
          threshold: BAN_THRESHOLD,
          voterRoleId,
          flavor: bot.voteFlavor,
        }),
      );
      await msgReact(judge_msg, ['👍'], bot.logger, bot.clientId);

      // judgement time
      const current_time = Date.now();
      const end_time = current_time + JUDGE_TIME * 60 * 1000;
      const end_time_date = new Date(end_time);

      const ban_judgement = async () => {
        const emoji = judge_msg.reactions.resolve('👍');
        if (!emoji) {
          await judge_msg.reply(bot.translator?.t('replies:ban_user.cannot_get_votes') ?? '');
          return;
        }
        const judge_count = emoji.count - 1;
        if (judge_count >= BAN_THRESHOLD) {
          try {
            await member.timeout(
              duration * 60 * 1000,
              bot.translator?.t('replies:ban_user.timeout_reason', { persona: bot.personaName }) ??
                '',
            );
            await judge_msg.reply(
              bot.translator?.t('replies:ban_user.timed_out', {
                persona: bot.personaName,
                user: member.user.tag,
                duration,
              }) ?? '',
            );
          } catch (timeoutErr) {
            // Usually a missing ModerateMembers permission or a
            // target above the bot in the role hierarchy. The
            // fallback below still runs, but the operator needs
            // to see which one it was.
            logError(bot.logger, interaction.guild?.id, timeoutErr);
            await judge_msg.reply(
              bot.translator?.t('replies:ban_user.cannot_timeout', { persona: bot.personaName }) ??
                '',
            );
            startMessageDeletionFallback({
              client: bot.client,
              logger: bot.logger,
              targetMemberId: member.id,
              guildId: interaction.guild?.id,
              durationMs: duration * 60 * 1000,
            });
          }
        } else {
          await judge_msg.reply(
            bot.translator?.t('replies:ban_user.vote_failed', {
              count: judge_count,
              threshold: BAN_THRESHOLD,
            }) ?? '',
          );
        }
      };
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
