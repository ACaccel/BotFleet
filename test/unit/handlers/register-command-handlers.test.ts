/**
 * `registerCommands` failure isolation.
 *
 * The whole loop used to sit inside one `try`, so the first handler that
 * threw aborted registration for every command after it — and the
 * failure was reported through `logSystem` (info level, message only),
 * which hid both the severity and the cause.
 *
 * The generated registry is replaced with three purpose-built handlers
 * so the test drives the real `registerCommands` control flow without
 * loading every command module.
 */
/* eslint-disable import/first */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/handlers/commands/registry.generated', async () => {
  const { Command } = await import('../../../src/handlers/commands/command');

  class Healthy extends Command {
    public constructor(name: string) {
      super();
      this.setConfig({ name, category: 'utility' });
    }
    public override async execute(): Promise<void> {}
  }

  class GoodOne extends Healthy {
    public constructor() {
      super('good_one');
    }
  }
  class GoodTwo extends Healthy {
    public constructor() {
      super('good_two');
    }
  }
  class NeedsConfig extends Healthy {
    public constructor() {
      super('needs_config');
    }
    public override validateBotConfig(): void {
      throw new Error('random_restaurant.apiUrl is required');
    }
  }

  return {
    COMMAND_REGISTRY: { good_one: GoodOne, good_two: GoodTwo, needs_config: NeedsConfig },
  };
});

import type { Command } from '../../../src/handlers/commands';
import { registerCommands } from '../../../src/handlers/commands';
import { buildFakeBot } from '../../fixtures/discord/bot-fake';

const buildBot = (commands: readonly string[] | undefined) => {
  const { bot, logger } = buildFakeBot({
    config: commands === undefined ? {} : { commands: [...commands] },
    commandHandlers: new Map<string, Command>(),
  });
  return { bot, error: logger.error };
};

describe('registerCommands', () => {
  it('skips a command that fails its own config validation and keeps the rest', async () => {
    const { bot, error } = buildBot(['good_one', 'needs_config', 'good_two']);

    await registerCommands(bot);

    // A single bad block used to abort the whole registration loop.
    expect([...bot.commandHandlers.keys()].sort()).toEqual(['good_one', 'good_two']);
    // Error level, not the previous info-level system line.
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('attaches the original failure as the logged error cause', async () => {
    const { bot, error } = buildBot(['needs_config']);

    await registerCommands(bot);

    const logged = (error.mock.calls[0] as [{ err: Error }])[0].err;
    expect(logged.message).toMatch(/Failed to register command needs_config/);
    expect((logged.cause as Error).message).toMatch(/apiUrl is required/);
  });

  it('does nothing when the personality lists no commands', async () => {
    const { bot, error } = buildBot(undefined);

    await registerCommands(bot);

    expect(bot.commandHandlers.size).toBe(0);
    expect(error).not.toHaveBeenCalled();
  });
});
