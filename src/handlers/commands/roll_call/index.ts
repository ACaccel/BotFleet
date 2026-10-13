import type { ChatInputCommandInteraction, GuildMember } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';
import { msgReact } from '../discord-helpers';

import { replyForError } from '../../../infra/discord/reply-for-error';
import { ROLL_CALL_MAX_TARGETS, resolveRollCallTargets } from './resolve-targets';
import { createGuildMemberSource } from './member-source';
import { rollCallOutcomeReply } from './outcome-reply';
import { activityParticipantsReply, claimActivityParticipants } from './activity-participants';
import { getOptionalString } from '../../../infra/discord/options';
export default class roll_call extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'roll_call',
      category: 'server_activity',
      guildOnly: true,
      options: {
        string: [
          {
            name: 'users',
            required: false,
          },
          {
            name: 'activity_id',
            required: false,
          },
        ],
      },
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    try {
      const users = getOptionalString(interaction, 'users');
      const activity_id = getOptionalString(interaction, 'activity_id');

      if (!users && !activity_id) {
        await interaction.reply({
          content: bot.translator?.t('replies:roll_call.missing_target') ?? '',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const validUsers: GuildMember[] = [];

      if (activity_id) {
        const guild = interaction.guild;
        // A repo `err` inside the claim is re-thrown into the
        // surrounding catch, which stamps a trace id.
        const outcome = await claimActivityParticipants(
          guild,
          guild === null ? undefined : bot.getRepos(guild.id),
          activity_id,
        );
        if (outcome.status !== 'ok') {
          const { key, params } = activityParticipantsReply(outcome, activity_id);
          await interaction.reply({
            content: bot.translator?.t(key, params) ?? '',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        validUsers.push(...outcome.members);
      } else if (users) {
        const guild = interaction.guild;
        if (!guild) {
          await interaction.reply({
            content: bot.translator?.t('errors:command.guild_not_found') ?? '',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        // A full member fetch is required so role membership reflects
        // every member, not just the gateway cache. It can exceed the
        // 3s interaction window, so acknowledge first with a defer.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const source = createGuildMemberSource(guild, await guild.members.fetch());
        const outcome = resolveRollCallTargets(users, source, ROLL_CALL_MAX_TARGETS);
        if (outcome.status !== 'ok') {
          const { key, params } = rollCallOutcomeReply(outcome);
          await interaction.editReply({ content: bot.translator?.t(key, params) ?? '' });
          return;
        }
        validUsers.push(...outcome.members);
      }

      let announcement =
        bot.translator?.t('replies:roll_call.announcement_header', {
          userId: interaction.user.id,
        }) ?? '';
      if (activity_id) {
        announcement +=
          bot.translator?.t('replies:roll_call.activity_id_line', { id: activity_id }) ?? '';
      }
      let id = 1;
      validUsers.forEach((user) => {
        announcement += `${id}. <@${user.id}>\n`;
        id += 1;
      });

      const ch = interaction.channel;
      if (!ch?.isSendable()) return;
      const msg = await ch.send({ content: announcement });
      void msgReact(msg, ['<:slowpoke_wave_lr:1178718404102848573>'], bot.logger, bot.clientId);
      // The users branch defers (see above); the activity branch does
      // not. Send the confirmation through whichever channel is open.
      const sent = bot.translator?.t('replies:roll_call.sent') ?? '';
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: sent });
      } else {
        await interaction.reply({ content: sent, flags: MessageFlags.Ephemeral });
      }
    } catch (error) {
      await replyForError(
        interaction,
        bot,
        error,
        'replies:roll_call.failed',
        interaction.guild?.id,
      );
    }
  }
}
