/**
 * Unit tests for BaseBot's admin resolution.
 *
 * `config.admin` is a list of Discord user ids; the constructor copies it
 * into `adminIds` (defaulting to `[]`) and `isAdmin` is the single
 * membership check the admin-gated handlers use. Constructed through the
 * `Tomori` personality with the handler barrels mocked, matching
 * `tomori-composition.test.ts`.
 */
/* eslint-disable import/first */
import { describe, expect, it } from 'vitest';

import { vi } from 'vitest';

import { buildInertClient } from '../../fixtures/discord/client-builder';
import { barrelStubs } from '../../fixtures/handler-barrel-stubs';

vi.mock('@cmd', () => barrelStubs.cmd);
vi.mock('@button', () => barrelStubs.button);
vi.mock('@modal', () => barrelStubs.modal);
vi.mock('@select-menu', () => barrelStubs.selectMenu);

import type { Config } from '../../../src/bot/index';
import { Tomori } from '../../../src/bot/tomori/tomori';

const buildBot = (config: Config): Tomori =>
  new Tomori(buildInertClient(), 'token', '', 'bot-client', config);

describe('BaseBot admin ids', () => {
  it('resolves adminIds from config.admin and matches via isAdmin', () => {
    const bot = buildBot({ admin: ['admin-a', 'admin-b'], commands: [] });
    expect(bot.adminIds).toEqual(['admin-a', 'admin-b']);
    expect(bot.isAdmin('admin-a')).toBe(true);
    expect(bot.isAdmin('admin-b')).toBe(true);
    expect(bot.isAdmin('someone-else')).toBe(false);
  });

  it('defaults adminIds to [] when config omits admin', () => {
    const bot = buildBot({ commands: [] });
    expect(bot.adminIds).toEqual([]);
    expect(bot.isAdmin('anyone')).toBe(false);
  });
});
