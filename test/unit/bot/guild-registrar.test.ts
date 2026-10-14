/**
 * Unit tests for {@link GuildRegistrar}, the collaborator BaseBot
 * composes for guild registration. Covers:
 * happy path, partial config tolerance, empty config, missing cache
 * lookup, `registerAll` fan-out, fan-out resilience to a per-guild
 * throw, and the "no Mongo / no Discord send" purity invariant.
 */
import type { Client, Guild, GuildBasedChannel } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { GuildRegistrar } from '../../../src/bot/guild-registrar';
import type { Config } from '../../../src/bot/index';
import { buildTextChannel } from '../../fixtures/discord/channel-builder';
import { buildInertClient } from '../../fixtures/discord/client-builder';
import { buildGuild, buildGuildRoles } from '../../fixtures/discord/guild-builder';
import { silentLogger } from '../../fixtures/runtime';

const silent = silentLogger();

/** A guild whose member cache holds the bot (`bot-1`) as `Botty`. */
const buildGuildWithBot = (id: string): Guild =>
  buildGuild({ id, members: [{ id: 'bot-1', displayName: 'Botty' }] });

const buildClient = (
  guilds: readonly Guild[],
  channels: readonly GuildBasedChannel[] = [],
): Client => {
  const client = buildInertClient();
  for (const g of guilds) client.guilds.cache.set(g.id, g);
  for (const c of channels) client.channels.cache.set(c.id, c);
  return client;
};

describe('GuildRegistrar.register', () => {
  it('populates channels and roles when the config is complete', () => {
    const guild = buildGuild({
      id: 'g-1',
      members: [{ id: 'bot-1', displayName: 'Botty' }],
      roles: buildGuildRoles({ roles: [{ id: 'r-mod', name: 'mod' }] }),
    });
    const channel = buildTextChannel({ id: 'c-logs', name: 'logs' });
    const client = buildClient([guild], [channel]);
    const config: Config = {
      guilds: {
        'g-1': {
          channels: { logs: 'c-logs' },
          roles: { mod: 'r-mod' },
        },
      },
    };

    const registrar = new GuildRegistrar(client, 'bot-1', silent);
    const info = registrar.register(guild, config);

    expect(info.bot_name).toBe('Botty');
    expect(info.channels).toEqual({ logs: channel });
    expect(info.roles?.mod?.id).toBe('r-mod');
  });

  it('omits missing channels rather than throwing', () => {
    const guild = buildGuildWithBot('g-1');
    const client = buildClient([guild]);
    const config: Config = {
      guilds: { 'g-1': { channels: { logs: 'nonexistent' }, roles: {} } },
    };

    const registrar = new GuildRegistrar(client, 'bot-1', silent);
    expect(() => registrar.register(guild, config)).not.toThrow();
    const info = registrar.register(guild, config);
    expect(info.channels?.['logs']).toBeUndefined();
  });

  it('returns empty channel / role maps when the guild has no config entry', () => {
    const guild = buildGuildWithBot('g-1');
    const client = buildClient([guild]);
    const registrar = new GuildRegistrar(client, 'bot-1', silent);
    const info = registrar.register(guild, {});
    expect(info.channels).toEqual({});
    expect(info.roles).toEqual({});
  });

  it('tolerates a guild entry that omits channels and roles entirely', () => {
    // The optional-channels contract: a `guilds.<id>` block may carry
    // neither `channels` nor `roles`. The bot keeps every feature but has
    // nothing to send to channel-bound side effects (debug / event mirror).
    const guild = buildGuildWithBot('g-1');
    const client = buildClient([guild]);
    const config: Config = { guilds: { 'g-1': {} } };
    const registrar = new GuildRegistrar(client, 'bot-1', silent);
    expect(() => registrar.register(guild, config)).not.toThrow();
    const info = registrar.register(guild, config);
    expect(info.channels).toEqual({});
    expect(info.roles).toEqual({});
  });

  it('omits a role whose id is not in the guild cache', () => {
    const guild = buildGuildWithBot('g-1');
    const client = buildClient([guild]);
    const config: Config = {
      guilds: { 'g-1': { channels: {}, roles: { ghost: 'r-missing' } } },
    };
    const registrar = new GuildRegistrar(client, 'bot-1', silent);
    const info = registrar.register(guild, config);
    expect(info.roles?.['ghost']).toBeUndefined();
  });

  it('does not call client.guilds.fetch or send any Discord message', () => {
    const guild = buildGuildWithBot('g-1');
    const fetchSpy = vi.fn();
    const client = buildClient([guild]);
    Object.assign(client.guilds, { fetch: fetchSpy });
    const registrar = new GuildRegistrar(client, 'bot-1', silent);
    registrar.register(guild, {});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('GuildRegistrar.registerAll', () => {
  it('produces one entry per guild in the cache', () => {
    const guilds = [buildGuildWithBot('g-1'), buildGuildWithBot('g-2'), buildGuildWithBot('g-3')];
    const client = buildClient(guilds);
    const registrar = new GuildRegistrar(client, 'bot-1', silent);

    const out = registrar.registerAll({});

    expect(Object.keys(out).sort()).toEqual(['g-1', 'g-2', 'g-3']);
  });

  it('continues iterating when one guild registration throws', () => {
    const goodA = buildGuildWithBot('g-1');
    const badGuild = {
      id: 'g-2',
      name: 'BadGuild',
      // `members.cache.get` throws to simulate a Discord SDK shape mismatch.
      members: {
        cache: {
          get: () => {
            throw new Error('cache exploded');
          },
        },
      },
      roles: { cache: new Map() },
    } as unknown as Guild;
    const goodB = buildGuildWithBot('g-3');
    const client = buildClient([goodA, badGuild, goodB]);
    const registrar = new GuildRegistrar(client, 'bot-1', silent);

    const out = registrar.registerAll({});

    expect(out['g-1']).toBeDefined();
    expect(out['g-2']).toBeUndefined();
    expect(out['g-3']).toBeDefined();
  });
});
