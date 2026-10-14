import type { ContextMenuCommandType, UserContextMenuCommandInteraction } from 'discord.js';
import { ApplicationCommandType } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { replyWithAvatar } from '../avatar-shared/reply-avatar';

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
    await replyWithAvatar(interaction, bot, interaction.targetUser);
  }
}
