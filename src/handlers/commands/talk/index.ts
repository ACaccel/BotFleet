import type { ChatInputCommandInteraction, GuildBasedChannel } from 'discord.js';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { replyForError } from '../../../infra/discord/reply-for-error';
import { getRequiredString } from '../../../infra/discord/options';
import { ancestorChannelIdsOf } from '../../../infra/discord';

/** Leaves room for the `displayName(username): ` signature under Discord's 2000 limit. */
const MAX_CONTENT_LENGTH = 1900;

export default class talk extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'talk',
      category: 'fun',
      guildOnly: true,
      options: {
        string: [{ name: 'content', required: true, maxLength: MAX_CONTENT_LENGTH }],
        channel: [{ name: 'channel', required: false }],
        boolean: [{ name: 'anonymous', required: false }],
      },
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    const t = (key: string, params?: Record<string, string>): string =>
      bot.translator?.t(key, params) ?? '';
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const content = getRequiredString(interaction, 'content');
      const anonymous = interaction.options.getBoolean('anonymous') === true;
      // Unsigned speech is untraceable to members, so only bot admins may use it.
      if (anonymous && !bot.isAdmin(interaction.user.id)) {
        await interaction.editReply({ content: t('errors:permission.admin_only_short') });
        return;
      }
      const chosen = interaction.options.getChannel('channel')?.id;
      const channel = chosen
        ? interaction.guild?.channels.cache.get(chosen)
        : (interaction.channel ?? undefined);
      if (!channel?.isSendable() || !mayPost(channel as GuildBasedChannel, interaction)) {
        await interaction.editReply({ content: t('replies:talk.channel_not_allowed') });
        return;
      }
      if (
        bot.guildSettings &&
        interaction.guildId &&
        !bot.guildSettings.isEnabled(
          interaction.guildId,
          'talk',
          channel.id,
          ancestorChannelIdsOf(channel, interaction.guild?.channels.cache),
        )
      ) {
        await interaction.editReply({
          content: t('replies:settings.feature_disabled', {
            feature: t('replies:settings.feature.talk'),
          }),
        });
        return;
      }

      const displayName =
        interaction.member && 'displayName' in interaction.member
          ? interaction.member.displayName
          : interaction.user.displayName;
      const username = interaction.user.username;
      if (content.includes('@everyone') || content.includes('@here')) {
        await channel.send({
          content: t('replies:talk.tag_warning', { displayName, username }),
          allowedMentions: { parse: [] },
        });
      } else {
        await channel.send({
          content: anonymous ? content : `${displayName}(${username}): ${content}`,
          allowedMentions: { parse: ['users', 'roles'] },
        });
        if (anonymous) {
          bot.logger?.info(
            {
              guildId: interaction.guildId,
              channelId: channel.id,
              userId: interaction.user.id,
              content,
            },
            'anonymous /talk message sent',
          );
        }
      }
      await interaction.deleteReply();
    } catch (error) {
      await replyForError(interaction, bot, error, 'replies:talk.failed', interaction.guildId);
    }
  }
}

/** The member must be able to post there themselves; the bot is not a way around channel rules. */
const mayPost = (channel: GuildBasedChannel, interaction: ChatInputCommandInteraction): boolean => {
  const permissions = channel.permissionsFor(interaction.user);
  const send = channel.isThread()
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;
  return permissions?.has([PermissionFlagsBits.ViewChannel, send]) === true;
};
