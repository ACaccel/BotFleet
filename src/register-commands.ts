/**
 * Build the command JSON `npm run register` publishes for one bot.
 *
 * Split out of `register.ts` so it can be unit-tested without the CLI's
 * file-system and REST side effects.
 */
import type { ApplicationCommandDataResolvable } from 'discord.js';

import { buildCommandJsonBody, createCommand, localizeCommandConfig } from '@cmd';
import type { Logger } from '@core/logger';
import type { Translator } from '@core/i18n';

/**
 * Localised command bodies for `commands`, in order. An unknown name
 * throws, as it does when the bot starts; a command whose bot-config
 * block is invalid is skipped with a warning, mirroring the running bot,
 * which would otherwise answer it with "command not found".
 */
export const buildCommandsFromConfig = (
  commands: readonly string[],
  translator: Translator,
  config: unknown,
  logger: Pick<Logger, 'warn'>,
): ApplicationCommandDataResolvable[] => {
  const out: ApplicationCommandDataResolvable[] = [];
  for (const name of commands) {
    const instance = createCommand(name);
    if (!instance) throw new Error(`Unknown command in config.commands: ${name}`);
    try {
      instance.validateBotConfig?.(config);
    } catch (err) {
      logger.warn({ command: name, err }, 'Skipping command with invalid bot configuration.');
      continue;
    }
    // Descriptions are i18n keys resolved against the `commands` catalog.
    out.push(buildCommandJsonBody(localizeCommandConfig(instance.config, translator)));
  }
  return out;
};
