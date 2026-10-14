/**
 * The avatar reply shared by the user menu and the message menu, so
 * both show the same embed for the same person.
 */
import type {
  MessageContextMenuCommandInteraction,
  User,
  UserContextMenuCommandInteraction,
} from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import type { BaseBot } from '@bot';

import { EMBED_COLORS } from '../../../infra/discord/presentation-colors';
import { replyForError } from '../../../infra/discord/reply-for-error';

/** Discord's largest avatar size; animated avatars keep their GIF format. */
const AVATAR_SIZE = 4096;

export const replyWithAvatar = async (
  interaction: UserContextMenuCommandInteraction | MessageContextMenuCommandInteraction,
  bot: BaseBot,
  user: User,
): Promise<void> => {
  await interaction.deferReply();
  const t = (key: string, params?: Record<string, string>): string =>
    bot.translator?.t(`replies:menu_get_avatar.${key}`, params) ?? '';
  try {
    const member = (await interaction.guild?.members.fetch(user.id).catch(() => null)) ?? undefined;
    const globalUrl = user.displayAvatarURL({ size: AVATAR_SIZE });
    // A server profile avatar takes precedence, as Discord shows it in that server.
    const serverUrl = member?.avatar ? member.displayAvatarURL({ size: AVATAR_SIZE }) : undefined;

    const embed = new EmbedBuilder()
      .setTitle(t('title', { user: member?.displayName ?? user.displayName }))
      .setColor(EMBED_COLORS.info)
      .setImage(serverUrl ?? globalUrl);
    if (serverUrl !== undefined) {
      embed.addFields({ name: t('server_avatar_field'), value: serverUrl });
    }
    embed.addFields({ name: t('avatar_url_field'), value: globalUrl });

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    await replyForError(
      interaction,
      bot,
      error,
      'replies:menu_get_avatar.failed',
      interaction.guildId,
    );
  }
};
