import { describe, expect, it } from 'vitest';

import { getCommandJsonBody, registerCommands, type Command } from '../../../src/handlers/commands';
import { buildFakeBot } from '../../fixtures/discord/bot-fake';

describe('command registration after recording removal', () => {
  it('omits a stale record entry from handlers and deployment while preserving other commands', async () => {
    const { bot, logger } = buildFakeBot({
      config: { commands: ['help', 'record', 'give_score'] },
      commandHandlers: new Map<string, Command>(),
    });

    await registerCommands(bot);

    expect([...bot.commandHandlers.keys()]).toEqual(['help', 'give_score']);
    expect(
      getCommandJsonBody(bot.commandHandlers, bot).map((command) =>
        'toJSON' in command ? command.toJSON().name : command.name,
      ),
    ).toEqual(['help', 'give_score']);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
