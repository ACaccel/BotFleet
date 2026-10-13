import { EMBED_COLORS } from '../../../infra/discord/presentation-colors';
import type { ContextMenuCommandType, UserContextMenuCommandInteraction } from 'discord.js';
import { EmbedBuilder, ApplicationCommandType } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { replyForError } from '../../../infra/discord/reply-for-error';

/** Discord's largest avatar size; animated avatars keep their GIF format. */
const AVATAR_SIZE = 4096;

export default class menu_get_avatar extends Command {
  constructor() {
    super();
    this.setConfig({
      // Stable ASCII id; the user-facing Discord name is resolved
      // from `commands:menu_get_avatar.name`.
      name: 'menu_get_avatar',
      category: 'utility',
      type: ApplicationCommandType.User as ContextMenuCommandType,
    });
  }

  public override async execute(
    interaction: UserContextMenuCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply();
    const t = (key: string, params?: Record<string, string>): string =>
      bot.translator?.t(`replies:menu_get_avatar.${key}`, params) ?? '';
    try {
      const user = interaction.targetUser;
      const member =
        (await interaction.guild?.members.fetch(user.id).catch(() => null)) ?? undefined;
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
  }
}
