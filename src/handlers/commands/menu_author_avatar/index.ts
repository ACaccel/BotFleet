import type { ContextMenuCommandType, MessageContextMenuCommandInteraction } from 'discord.js';
import { ApplicationCommandType } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { replyWithAvatar } from '../avatar-shared/reply-avatar';

/**
 * The message-menu twin of `menu_get_avatar`: Discord lists user menus
 * only when a member is right-clicked, so a message gets its own entry.
 */
export default class menu_author_avatar extends Command {
  constructor() {
    super();
    this.setConfig({
      // Stable ASCII id; the user-facing Discord name is resolved
      // from `commands:menu_author_avatar.name`.
      name: 'menu_author_avatar',
      category: 'utility',
      type: ApplicationCommandType.Message as ContextMenuCommandType,
    });
  }

  public override async execute(
    interaction: MessageContextMenuCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await replyWithAvatar(interaction, bot, interaction.targetMessage.author);
  }
}
