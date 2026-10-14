/**
 * Unit tests for BaseBot's `guildInfo` read accessors and the narrow
 * write seams (`registerGuildSlotInternal`, `updateBotName`, `attachRepos`).
 *
 * `guildInfo` is held as a private `Map` exposed through
 * `getGuildInfo`, `getAllGuildInfo`, and `getRepos`, rather than a
 * public mutable `Record`. These tests assert the read /
 * write contract from the consumer side without reaching into BaseBot
 * internals.
 */
/* eslint-disable import/first */
import { describe, expect, it, vi } from 'vitest';
import type { Channel, Guild } from 'discord.js';
import type { Job } from 'node-schedule';

import { buildInertClient } from '../../fixtures/discord/client-builder';
import { barrelStubs } from '../../fixtures/handler-barrel-stubs';

vi.mock('@cmd', () => barrelStubs.cmd);
vi.mock('@button', () => barrelStubs.button);
vi.mock('@modal', () => barrelStubs.modal);
vi.mock('@select-menu', () => barrelStubs.selectMenu);

import { BaseBot, type Config, type GuildInfo } from '../../../src/bot/index';
import type { Repos } from '../../../src/persistence/repositories';
import { TOKENS } from '../../../src/bot/tokens';
import { archiveControlFactory } from '../../../src/application/archive/control';
import { buildArchiveRepos } from '../../../src/persistence/repositories/archive-repos';

const fakeGuild = (id: string): Guild => ({ id, name: `Guild ${id}` }) as unknown as Guild;

const fakeRepos = (): Repos => ({}) as unknown as Repos;

/**
 * Test-only subclass that re-exposes BaseBot's TS-private `attachRepos`
 * so the test can exercise the repos-attachment seam without spinning
 * up the full `GuildDbConnector` collaborator.
 */
class TestBot extends BaseBot<Config> {
  public exposeAttachRepos(guildId: string, repos: Repos): void {
    // `attachRepos` is TS-private; accessing it through bracket notation
    // keeps the test honest about its testing-seam status.
    (this as unknown as { attachRepos: (g: string, r: Repos) => void }).attachRepos(guildId, repos);
  }
}

const buildBot = (): TestBot =>
  new TestBot(buildInertClient(), 'token', '', 'bot-client', {} satisfies Config);

describe('BaseBot guildInfo accessors', () => {
  it('getGuildInfo returns undefined for an unregistered guild', () => {
    const bot = buildBot();
    expect(bot.getGuildInfo('missing')).toBeUndefined();
  });

  it('getGuildInfo returns the stored info after registerGuildSlotInternal', () => {
    const bot = buildBot();
    const info: GuildInfo = { bot_name: 'Nijika', guild: fakeGuild('g-1') };
    bot.registerGuildSlotInternal('g-1', info);

    const got = bot.getGuildInfo('g-1');
    expect(got).toBeDefined();
    expect(got?.bot_name).toBe('Nijika');
    expect(got?.guild.id).toBe('g-1');
  });

  it('getAllGuildInfo returns a Map view that reflects later inserts', () => {
    const bot = buildBot();
    const view = bot.getAllGuildInfo();
    expect(view).toBeInstanceOf(Map);
    expect(view.size).toBe(0);

    bot.registerGuildSlotInternal('g-1', { bot_name: 'A', guild: fakeGuild('g-1') });
    bot.registerGuildSlotInternal('g-2', { bot_name: 'B', guild: fakeGuild('g-2') });

    // Same reference, post-insert size must reflect new entries.
    expect(view.size).toBe(2);
    expect(Array.from(view.keys()).sort()).toEqual(['g-1', 'g-2']);
  });

  it('getRepos returns undefined before attachRepos and the repos after', () => {
    const bot = buildBot();
    bot.registerGuildSlotInternal('g-1', { bot_name: 'A', guild: fakeGuild('g-1') });

    expect(bot.getRepos('g-1')).toBeUndefined();

    const repos = fakeRepos();
    bot.exposeAttachRepos('g-1', repos);

    expect(bot.getRepos('g-1')).toBe(repos);
    // The slot is preserved; only `repos` is filled in.
    expect(bot.getGuildInfo('g-1')?.bot_name).toBe('A');
  });

  it('attachRepos is a no-op when the guild has not been registered', () => {
    const bot = buildBot();
    bot.exposeAttachRepos('never-registered', fakeRepos());
    expect(bot.getGuildInfo('never-registered')).toBeUndefined();
    expect(bot.getRepos('never-registered')).toBeUndefined();
  });

  it('updateBotName replaces only the bot_name field of the slot', () => {
    const bot = buildBot();
    const guild = fakeGuild('g-1');
    bot.registerGuildSlotInternal('g-1', { bot_name: 'Original', guild });

    bot.updateBotName('g-1', 'Renamed');

    const slot = bot.getGuildInfo('g-1');
    expect(slot?.bot_name).toBe('Renamed');
    expect(slot?.guild).toBe(guild);
  });

  it('updateBotName is a no-op when the guild has not been registered', () => {
    const bot = buildBot();
    bot.updateBotName('missing', 'irrelevant');
    expect(bot.getGuildInfo('missing')).toBeUndefined();
  });
});

/**
 * The accessors the handler-side `deps-from-bot` bridges read. Each must
 * hand back the very object the container binds under the matching
 * token, because that identity is what keeps a plugin's own
 * `ctx.resolve` path and its handler path pointed at one instance.
 */
describe('BaseBot container-backed accessors', () => {
  it('guildRegistry is the object bound under TOKENS.GuildRegistry', () => {
    const bot = buildBot();
    expect(bot.guildRegistry).toBe(bot.container.resolve(TOKENS.GuildRegistry));
  });

  it('guildRegistry reads through to the live guild slots', () => {
    const bot = buildBot();
    const channel = { id: 'c-1' } as unknown as Channel;
    bot.registerGuildSlotInternal('g-1', {
      bot_name: 'A',
      guild: fakeGuild('g-1'),
      channels: { event: channel },
    });

    // Registered after the registry was built, so a stale snapshot fails here.
    expect(bot.guildRegistry.listGuildIds()).toEqual(['g-1']);
    expect(bot.guildRegistry.getChannel('g-1', 'event')).toBe(channel);
    expect(bot.guildRegistry.getRole('g-1', 'staff')).toBeUndefined();
  });

  it('jobMap is the same map plugins resolve under TOKENS.JobMap', () => {
    const bot = buildBot();
    expect(bot.jobMap).toBe(bot.container.resolve(TOKENS.JobMap));

    bot.jobMap.set('job-1', {} as unknown as Job);
    expect(bot.container.resolve(TOKENS.JobMap).get('job-1')).toBeDefined();
  });

  it('archiveControlFactory is unbound until a composition root registers it', () => {
    const bot = buildBot();
    expect(bot.archiveControlFactory).toBeUndefined();
    const factory = archiveControlFactory(buildArchiveRepos);
    bot.container.registerSingleton(TOKENS.ArchiveControlFactory, () => factory);
    expect(bot.archiveControlFactory).toBe(factory);
  });

  it('requireLogger throws before run() binds the logger', () => {
    const bot = buildBot();
    expect(bot.logger).toBeUndefined();
    expect(() => bot.requireLogger()).toThrow(TypeError);
  });

  it('requireLogger returns the bound logger once it exists', () => {
    const bot = buildBot();
    const logger = bot.container.resolve(TOKENS.Logger);
    (bot as unknown as { logger: unknown }).logger = logger;

    expect(bot.requireLogger()).toBe(logger);
  });
});
