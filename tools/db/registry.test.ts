/**
 * Unit suite for the command registry: lookup, uniqueness, and the help
 * listing used when no/unknown subcommand is given.
 */
import { describe, expect, it } from 'vitest';

import { commandNames, describeCommands, findCommand } from './registry';

describe('db / registry', () => {
  it('finds each registered command by name', () => {
    expect(findCommand('drop-todo')?.name).toBe('drop-todo');
    expect(findCommand('drop-xfeed')?.name).toBe('drop-xfeed');
  });

  it('returns undefined for an unknown subcommand', () => {
    expect(findCommand('bogus')).toBeUndefined();
  });

  it('lists every command exactly once', () => {
    const names = commandNames();
    expect(names).toEqual(['drop-todo', 'drop-xfeed']);
    expect(new Set(names).size).toBe(names.length);
  });

  it('rejects retired message archive CLI commands', () => {
    for (const name of ['verify', 'migrate-timestamp', 'repair-messages']) {
      expect(findCommand(name)).toBeUndefined();
      expect(describeCommands()).not.toContain(name);
    }
  });

  it('mentions every command in the help listing', () => {
    const desc = describeCommands();
    for (const name of commandNames()) {
      expect(desc).toContain(name);
    }
  });
});
