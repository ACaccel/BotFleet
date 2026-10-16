/**
 * `/help command:` shows `replies:help.details.<command>`; a command
 * without an entry would show a bare key, so every registered command
 * needs one in every locale.
 */
import { describe, expect, it } from 'vitest';

import '../../src/handlers/commands';
import { COMMAND_REGISTRY } from '../../src/handlers/commands/registry.generated';
import en from '../../src/i18n/locales/en/replies.json';
import zh from '../../src/i18n/locales/zh-TW/replies.json';

describe('help details', () => {
  it.each(Object.keys(COMMAND_REGISTRY))('%s has a details entry in every locale', (name) => {
    const details = [zh, en].map(
      (catalog) => (catalog.help.details as Record<string, string | undefined>)[name],
    );
    expect(details.every((text) => typeof text === 'string' && text.length > 0)).toBe(true);
  });
});
