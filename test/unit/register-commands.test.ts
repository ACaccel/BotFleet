/**
 * `npm run register` must publish exactly the commands the running bot
 * serves: an unknown name fails as it does at startup, and a command
 * whose bot-config block is invalid is left out.
 */
import { describe, expect, it, vi } from 'vitest';

import { buildCommandsFromConfig } from '../../src/register-commands';
import { commandsForBot } from '../../src/bot/default-commands';
import { echoTranslator } from '../fixtures/runtime';

const translator = echoTranslator();

const namesOf = (body: readonly unknown[]): string[] =>
  body.map((entry) => (entry as { name: string }).name);

describe('buildCommandsFromConfig', () => {
  it.each(['tomori', 'nijika'])('publishes settings automatically for %s', (botName) => {
    for (const configured of [undefined, [], ['help'], ['help', 'settings']]) {
      const body = buildCommandsFromConfig(
        commandsForBot(botName, configured),
        translator,
        {},
        { warn: vi.fn() },
      );
      const names = namesOf(body);
      expect(names.filter((name) => name === 'settings')).toHaveLength(1);
      expect(names).toEqual(configured?.includes('help') ? ['help', 'settings'] : ['settings']);
    }
  });

  it.each(['gopher', 'konata', 'msg-archive'])('keeps %s command defaults unchanged', (botName) => {
    expect(commandsForBot(botName)).toEqual([]);
    expect(commandsForBot(botName, ['help'])).toEqual(['help']);
  });

  it('builds one body per configured command, in order', () => {
    const logger = { warn: vi.fn() };

    const body = buildCommandsFromConfig(['help', 'give_score'], translator, {}, logger);

    expect(namesOf(body)).toEqual(['help', 'give_score']);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('throws on a name that matches no handler', () => {
    expect(() =>
      buildCommandsFromConfig(['help', 'COMMAND_NAME'], translator, {}, { warn: vi.fn() }),
    ).toThrow(/Unknown command in config\.commands: COMMAND_NAME/);
  });

  it('skips a command whose bot-config block is invalid', () => {
    const logger = { warn: vi.fn() };

    // `random_restaurant` requires a `random_restaurant.apiUrl` block.
    const body = buildCommandsFromConfig(['help', 'random_restaurant'], translator, {}, logger);

    expect(namesOf(body)).toEqual(['help']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'random_restaurant' }),
      expect.any(String),
    );
  });
});
