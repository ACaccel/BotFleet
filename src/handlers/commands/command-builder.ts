import { ApplicationCommandType, type RESTPostAPIApplicationCommandsJSONBody } from 'discord.js';
import { ContextMenuCommandBuilder, SlashCommandBuilder } from '@discordjs/builders';
import type { LocalizedCommandConfig } from './command';
import { addCommandOptions } from './command-options';

/**
 * Translates a {@link LocalizedCommandConfig} into the Discord REST JSON
 * payload for command registration.
 *
 * Consumed both at deploy time (`src/register.ts`) and at runtime command
 * registration (`getCommandJsonBody`). It lives next to `command.ts`
 * because it operates purely on the localised command-metadata contract.
 */
export const buildCommandJsonBody = (
  config: LocalizedCommandConfig,
): RESTPostAPIApplicationCommandsJSONBody => {
  // Context menu commands carry no description / options.
  if (
    config.type === ApplicationCommandType.User ||
    config.type === ApplicationCommandType.Message
  ) {
    return new ContextMenuCommandBuilder().setName(config.name).setType(config.type).toJSON();
  }

  const slashCommand = new SlashCommandBuilder()
    .setName(config.name)
    .setDescription(config.description);

  if (config.defaultMemberPermissions !== undefined) {
    slashCommand.setDefaultMemberPermissions(config.defaultMemberPermissions);
  }
  if (config.guildOnly === true) slashCommand.setDMPermission(false);
  if (config.subcommandGroups !== undefined || config.subcommands !== undefined) {
    if (config.options !== undefined) {
      throw new TypeError(
        `command "${config.name}": subcommands cannot be combined with root options.`,
      );
    }
    for (const group of config.subcommandGroups ?? []) {
      slashCommand.addSubcommandGroup((builder) => {
        builder.setName(group.name).setDescription(group.description);
        for (const subcommand of group.subcommands) {
          builder.addSubcommand((subcommandBuilder) => {
            subcommandBuilder.setName(subcommand.name).setDescription(subcommand.description);
            addCommandOptions(subcommandBuilder, subcommand.options, config.name);
            return subcommandBuilder;
          });
        }
        return builder;
      });
    }
    for (const subcommand of config.subcommands ?? []) {
      slashCommand.addSubcommand((builder) => {
        builder.setName(subcommand.name).setDescription(subcommand.description);
        addCommandOptions(builder, subcommand.options, config.name);
        return builder;
      });
    }
  } else {
    addCommandOptions(slashCommand, config.options, config.name);
  }
  return slashCommand.toJSON();
};
