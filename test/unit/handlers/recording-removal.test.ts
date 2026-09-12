import { describe, expect, it } from 'vitest';

import { getCommandJsonBody, registerCommands, type Command } from '../../../src/handlers/commands';
import { buildFakeBot } from '../../fixtures/discord/bot-fake';

describe('command registration after recording removal', () => {
  it('omits a stale record entry from handlers and deployment while preserving other commands', async () => {
    const { bot, logger } = buildFakeBot({
      config: { commands: ['help', 'record', 'get_avatar'] },
      commandHandlers: new Map<string, Command>(),
    });

    await registerCommands(bot);

    expect([...bot.commandHandlers.keys()]).toEqual(['help', 'get_avatar']);
    expect(
      getCommandJsonBody(bot.commandHandlers, bot).map((command) =>
        'toJSON' in command ? command.toJSON().name : command.name,
      ),
    ).toEqual(['help', 'get_avatar']);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
