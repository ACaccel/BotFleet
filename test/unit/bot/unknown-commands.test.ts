/**
 * A misspelled or retired name in `config.commands` used to be skipped
 * silently, leaving members with "command not found". Construction now
 * refuses it before the bot logs in.
 */
/* eslint-disable import/first */
import { describe, expect, it, vi } from 'vitest';

import { barrelStubs } from '../../fixtures/handler-barrel-stubs';

vi.mock('@cmd', () => ({
  ...barrelStubs.cmd,
  getSlashCommandClass: (name: string): unknown => (name === 'help' ? class {} : undefined),
}));
vi.mock('@button', () => barrelStubs.button);
vi.mock('@modal', () => barrelStubs.modal);
vi.mock('@select-menu', () => barrelStubs.selectMenu);

import { BaseBot, type Config } from '../../../src/bot/index';
import { buildInertClient } from '../../fixtures/discord/client-builder';

class MinimalBot extends BaseBot<Config> {}

const client = buildInertClient();

describe('BaseBot config.commands validation', () => {
  it('accepts known command names', () => {
    expect(() => new MinimalBot(client, 't', '', 'bot-1', { commands: ['help'] })).not.toThrow();
  });

  it('refuses unknown command names, listing each one', () => {
    expect(
      () => new MinimalBot(client, 't', '', 'bot-1', { commands: ['help', 'typo', 'gone'] }),
    ).toThrow('Unknown command(s) in config.commands: typo, gone');
  });
});
