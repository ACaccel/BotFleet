/**
 * `npm run register` must publish exactly the commands the running bot
 * serves: an unknown name fails as it does at startup, and a command
 * whose bot-config block is invalid is left out.
 */
import { describe, expect, it, vi } from 'vitest';

import { buildCommandsFromConfig } from '../../src/register-commands';
import type { Translator } from '../../src/core/i18n';

const translator = {
  t: (key: string) => key,
  tStrict: (key: string) => key,
} as unknown as Translator;

const namesOf = (body: readonly unknown[]): string[] =>
  body.map((entry) => (entry as { name: string }).name);

describe('buildCommandsFromConfig', () => {
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
