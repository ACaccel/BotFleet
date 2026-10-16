import {
  MessageFlags,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { BaseBot } from '@bot';
import { Command, type CommandSuggestions } from '../command';

import { replyForError } from '../../../infra/discord/reply-for-error';
import { getOptionalString } from '../../../infra/discord/options';
import { buildCommandDetail } from './build-help-embed';
import { helpOverviewPayload } from './overview-payload';

export default class help extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'help',
      category: 'utility',
      options: { string: [{ name: 'command', required: false, autocomplete: true }] },
    });
  }

  public override autocomplete = async (
    interaction: AutocompleteInteraction,
    bot: BaseBot,
  ): Promise<CommandSuggestions> => {
    const typed = interaction.options.getFocused().toLowerCase();
    return [...bot.commandHandlers.values()]
      .filter((command) => command.config.type === undefined)
      .map((command) => command.config.name)
      .filter((name) => name.includes(typed))
      .sort()
      .map((name) => ({ name: `/${name}`, value: name }));
  };

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const viewer = { isAdmin: bot.isAdmin(interaction.user.id) };
      const requested = getOptionalString(interaction, 'command');
      if (requested !== undefined) {
        const command = [...bot.commandHandlers.values()].find(
          (candidate) => candidate.config.name === requested.replace(/^\//, ''),
        );
        await interaction.editReply(
          command === undefined
            ? {
                content:
                  bot.translator?.t('replies:help.unknown_command', { name: requested }) ?? '',
              }
            : { embeds: [buildCommandDetail(command, bot.translator, viewer)] },
        );
        return;
      }

      await interaction.editReply(
        helpOverviewPayload(bot, interaction.client.user, viewer.isAdmin),
      );
    } catch (error) {
      await replyForError(interaction, bot, error, 'replies:help.failed', interaction.guildId);
    }
  }
}
