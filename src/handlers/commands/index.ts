import type {
  ApplicationCommandDataResolvable,
  ChatInputCommandInteraction,
  ContextMenuCommandInteraction,
} from 'discord.js';
import type { BaseBot } from '@bot';
import { logError, logSystem, ops } from '../../core/logger';
import { HandlerFactory } from 'handlers';
import { replyTranslated } from '../reply-translated';
// `./command` and `./command-builder` are imported BEFORE
// `./registry.generated` so that the `Command` class binding lands on
// `module.exports` before the generated registry pulls in handler
// subclasses (which import `Command` back through this barrel). Using
// `import { X } from './command'; export { X };` rather than
// `export { X } from './command'` ensures the export getter is emitted
// at the import location, not at the source position of the re-export
// statement (which would place it after the registry require call).
import { Command, localizeCommandConfig } from './command';
import { buildCommandJsonBody } from './command-builder';
import { executeAutocomplete } from './autocomplete';
import { COMMAND_REGISTRY } from './registry.generated';

export { Command, localizeCommandConfig, buildCommandJsonBody, executeAutocomplete };
export type {
  CommandConfig,
  CommandSuggestions,
  LocalizedCommandConfig,
  LocalizedCommandOption,
} from './command';

export const getCommandJsonBody = (
  commandHandlers: Map<string, Command>,
  bot: BaseBot,
): ApplicationCommandDataResolvable[] => {
  const rest_commands: ApplicationCommandDataResolvable[] = Array.from(commandHandlers.values())
    .filter((cmd: Command) => {
      if (!cmd.config) {
        logError(bot.logger, null, ops.command.handlerMissingConfig(String(cmd)));
        return false;
      }
      return true;
    })
    .map((cmd: Command) => buildCommandJsonBody(localizeCommandConfig(cmd.config, bot.translator)));
  return rest_commands;
};

export const registerCommands = async (bot: BaseBot): Promise<void> => {
  logSystem(bot.logger, ops.command.registerStart());

  if (!bot.config.commands) {
    logSystem(bot.logger, ops.command.registerEmpty());
    return;
  }

  // Each command is registered independently: a handler that fails
  // its own config validation is skipped, and the rest of the bot's
  // command set still comes up. The failure is logged at error level
  // with the original `cause` attached — `logSystem` (info, message
  // only) hid both the severity and the stack, so a bad `config.json`
  // block looked like a routine startup line.
  for (const name of bot.config.commands) {
    try {
      const newCommand = createCommand(name);
      if (newCommand === undefined || newCommand === null) continue;
      newCommand.validateBotConfig?.(bot.config);
      // Key by the *localised* command name so the map key
      // matches the name Discord registers and echoes back as
      // `interaction.commandName`. For chat-input commands the
      // localised name equals `config.name` (a lowercase-ASCII
      // id); for context-menu commands it is the catalog
      // display name.
      const registeredName = localizeCommandConfig(newCommand.config, bot.translator).name;
      bot.commandHandlers.set(registeredName, newCommand);
    } catch (err) {
      logError(bot.logger, null, new Error(ops.command.registerFailed(name), { cause: err }));
    }
  }

  logSystem(bot.logger, ops.command.registerSuccess(bot.commandHandlers.size));
};

/**
 * Dispatch a slash-command / context-menu interaction to its handler.
 *
 * This function is purely concerned with handler lookup. Channel and
 * guild logging policy lives in `createChannelLoggingMiddleware` at the
 * composition root, keeping the dispatcher free of policy concerns.
 */
export const executeCommand = async (
  interaction: ChatInputCommandInteraction | ContextMenuCommandInteraction,
  bot: BaseBot,
): Promise<void> => {
  if (!bot.config.commands) {
    await replyTranslated(interaction, bot.translator, 'errors:command.config_missing');
    return;
  }
  if (!bot.commandHandlers) {
    await replyTranslated(interaction, bot.translator, 'errors:command.handler_not_initialised');
    return;
  }

  const handler = bot.commandHandlers.get(interaction.commandName);
  if (handler) {
    await handler.execute(interaction, bot);
  } else {
    await replyTranslated(interaction, bot.translator, 'errors:command.not_found', {
      name: interaction.commandName,
    });
  }
};

const commandHandlerFactory = new HandlerFactory<Command>();
commandHandlerFactory.registerFromRegistry(COMMAND_REGISTRY);

export const getSlashCommandClass = (name: string): (new () => Command) | undefined =>
  commandHandlerFactory.getConstructor(name);
export const createCommand = (name: string): Command | undefined =>
  commandHandlerFactory.create(name);
export const createAllSlashCommands = (): Map<string, Command> => commandHandlerFactory.createAll();
