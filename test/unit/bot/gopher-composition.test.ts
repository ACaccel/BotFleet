/**
 * Composition test for the Gopher personality.
 *
 * Gopher must register exactly the ported auto-reply plus its two
 * gopher-only plugins (settings-api, identity-sync). A drift where any is
 * dropped (or where llm-chat / earthquake leak in) would silently change
 * the bot's behaviour, and nothing else in the suite would catch it. This
 * test pins the contract by spying on `BaseBot.prototype.use`.
 */
/* eslint-disable import/first */
import { describe, expect, it, vi } from 'vitest';

import { buildInertClient } from '../../fixtures/discord/client-builder';
import { barrelStubs } from '../../fixtures/handler-barrel-stubs';

vi.mock('@cmd', () => barrelStubs.cmd);
vi.mock('@button', () => barrelStubs.button);
vi.mock('@modal', () => barrelStubs.modal);
vi.mock('@select-menu', () => barrelStubs.selectMenu);

import { BaseBot, type Config } from '../../../src/bot/index';
import { Gopher } from '../../../src/bot/gopher/gopher';
import type { Plugin } from '../../../src/core/plugin';

const collectRegisteredPluginIds = (): string[] => {
  const ids: string[] = [];
  const useSpy = vi.spyOn(BaseBot.prototype, 'use').mockImplementation(function (
    this: BaseBot,
    plugin: Plugin,
  ) {
    ids.push(plugin.id);
    return this;
  });
  try {
    // The store reads the colocated config.json; gopher is database-free so
    // an empty mongoURI is passed deliberately.
    new Gopher(
      buildInertClient(),
      'token',
      '',
      'bot-client',
      { commands: ['help'] } satisfies Config,
      4001,
      'key',
    );
  } finally {
    useSpy.mockRestore();
  }
  return ids;
};

describe('Gopher composition', () => {
  it('registers the ported auto-reply plus the two gopher-only plugins', () => {
    const ids = collectRegisteredPluginIds();
    expect(new Set(ids)).toEqual(new Set(['llm-auto-reply', 'settings-api', 'identity-sync']));
  });

  it('does not register llm-chat or earthquake', () => {
    const ids = collectRegisteredPluginIds();
    expect(ids).not.toContain('llm-chat');
    expect(ids).not.toContain('earthquake');
  });

  it('reports no connection manager rather than throwing on resolve', () => {
    // gopher is database-free. `bot.connectionManager` documents an
    // `undefined` result for that case; a registered factory that threw
    // instead turned every null-check into an exception (notably
    // `requireGuildRepos`' disabled-guild lookup).
    const gopher = new Gopher(
      buildInertClient(),
      'token',
      '',
      'bot-client',
      { commands: ['help'] } satisfies Config,
      4002,
      'key',
    );
    expect(gopher.connectionManager).toBeUndefined();
  });
});
