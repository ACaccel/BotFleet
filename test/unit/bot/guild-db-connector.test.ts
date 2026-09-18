/**
 * Unit tests for {@link GuildDbConnector}, the collaborator BaseBot
 * composes for per-guild database connection. Covers:
 *   1. happy connectOne → repos populated
 *   2. ReposFactory throw → log w/ traceId + re-throw normalised Error
 *   3. ReposFactory throws non-Error → still normalised + re-thrown
 *   4. connectAll fan-out resilient to a per-slot throw
 *   5. connectAll short-circuits when MongoURI is undefined
 *   6. isDisabled pass-through; missing manager → undefined
 */
import type { Guild } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { GuildDbConnector } from '../../../src/bot/guild-db-connector';
import type { GuildInfo } from '../../../src/bot/index';
import { createContainer } from '../../../src/core/ioc';
import { TOKENS, type ReposFactory } from '../../../src/bot/tokens';
import { createLogger } from '../../../src/core/logger';
import { DatabaseError } from '../../../src/core/errors/external-service-error';
import type { ConnectionManager } from '../../../src/infra/mongo/connection-manager';
import type { Repos } from '../../../src/persistence/repositories';

const silent = createLogger({ level: 'silent', pretty: false });

const fakeGuild = (id: string, name = `Guild ${id}`): Guild => ({ id, name }) as unknown as Guild;

const fakeRepos = (): Repos => ({}) as unknown as Repos;

const containerWith = (
  reposFactory?: ReposFactory,
  cm?: ConnectionManager,
): ReturnType<typeof createContainer> => {
  const c = createContainer();
  if (reposFactory !== undefined) {
    c.registerSingleton(TOKENS.ReposFactory, () => reposFactory);
  }
  if (cm !== undefined) {
    c.registerSingleton(TOKENS.ConnectionManager, () => cm);
  }
  return c;
};

describe('GuildDbConnector.connectOne', () => {
  it('returns the freshly built repos on success', async () => {
    const repos = fakeRepos();
    const factory: ReposFactory = vi.fn(async () => repos);
    const container = containerWith(factory);
    const connector = new GuildDbConnector(container, 'mongodb://x', silent);

    const result = await connector.connectOne('g-1');

    expect(result).toBe(repos);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when the bot was built without a Mongo URI', async () => {
    const factory: ReposFactory = vi.fn(async () => fakeRepos());
    const container = containerWith(factory);
    const connector = new GuildDbConnector(container, undefined, silent);

    expect(await connector.connectOne('g-1')).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it('re-throws a normalised Error when ReposFactory throws', async () => {
    const factory: ReposFactory = vi.fn(async () => {
      throw new Error('mongo unreachable');
    });
    const disabled = {
      traceId: 'trace-xyz',
      error: new DatabaseError({
        code: 'DATABASE_NETWORK',
        messageKey: 'errors:db.guild_disabled',
        messageParams: { traceId: 'trace-xyz' },
        context: { operation: 'GuildDbConnector.test', guildId: 'g-1' },
      }),
    };
    const cm: ConnectionManager = {
      isDisabled: () => disabled,
    } as unknown as ConnectionManager;
    const container = containerWith(factory, cm);
    const connector = new GuildDbConnector(container, 'mongodb://x', silent);

    await expect(connector.connectOne('g-1')).rejects.toThrow('mongo unreachable');
  });

  it('normalises a non-Error throw into an Error before re-throwing', async () => {
    const factory: ReposFactory = vi.fn(async () => {
      // String throws are a real failure mode (e.g. older mongo drivers).
      throw 'mongo died';
    });
    const container = containerWith(factory);
    const connector = new GuildDbConnector(container, 'mongodb://x', silent);

    await expect(connector.connectOne('g-1')).rejects.toBeInstanceOf(Error);
  });
});

describe('GuildDbConnector.connectAll', () => {
  it('continues fanning out when one slot throws and invokes attachRepos for successes', async () => {
    const reposA = fakeRepos();
    const reposC = fakeRepos();
    const factory: ReposFactory = vi.fn(async (guildId) => {
      if (String(guildId) === 'g-2') throw new Error('boom');
      if (String(guildId) === 'g-1') return reposA;
      return reposC;
    });
    const container = containerWith(factory);
    const connector = new GuildDbConnector(container, 'mongodb://x', silent);
    const guildInfo = new Map<string, GuildInfo>([
      ['g-1', { bot_name: '', guild: fakeGuild('g-1') }],
      ['g-2', { bot_name: '', guild: fakeGuild('g-2') }],
      ['g-3', { bot_name: '', guild: fakeGuild('g-3') }],
    ]);
    const attached = new Map<string, Repos>();

    await connector.connectAll(guildInfo, (guildId, repos) => {
      attached.set(guildId, repos);
    });

    expect(attached.get('g-1')).toBe(reposA);
    expect(attached.has('g-2')).toBe(false);
    expect(attached.get('g-3')).toBe(reposC);
  });

  it('short-circuits when no Mongo URI was configured', async () => {
    const factory: ReposFactory = vi.fn(async () => fakeRepos());
    const container = containerWith(factory);
    const connector = new GuildDbConnector(container, undefined, silent);
    const attach = vi.fn();

    await connector.connectAll(
      new Map<string, GuildInfo>([['g-1', { bot_name: '', guild: fakeGuild('g-1') }]]),
      attach,
    );

    expect(factory).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });
});

describe('GuildDbConnector.isDisabled', () => {
  it('passes through to ConnectionManager.isDisabled', () => {
    const expected = {
      traceId: 't-1',
      error: new DatabaseError({
        code: 'DATABASE_TIMEOUT',
        messageKey: 'errors:db.guild_disabled',
        messageParams: { traceId: 't-1' },
        context: { operation: 'GuildDbConnector.test', guildId: 'g-1' },
      }),
    };
    const cm: ConnectionManager = {
      isDisabled: vi.fn(() => expected),
    } as unknown as ConnectionManager;
    const container = containerWith(undefined, cm);
    const connector = new GuildDbConnector(container, 'mongodb://x', silent);

    expect(connector.isDisabled('g-1')).toEqual(expected);
  });

  it('returns undefined when no ConnectionManager is bound', () => {
    const container = createContainer();
    const connector = new GuildDbConnector(container, undefined, silent);
    expect(connector.isDisabled('g-1')).toBeUndefined();
  });
});

describe('GuildDbConnector recovery', () => {
  it('recovers missing repos once and leaves healthy and permanently disabled guilds alone', async () => {
    vi.useFakeTimers();
    const repos = fakeRepos();
    const factory = vi.fn(async () => repos);
    const permanent = new DatabaseError({
      code: 'DATABASE_UNKNOWN',
      messageKey: 'errors:db.not_found',
      context: { operation: 'test' },
    });
    const cm = {
      isDisabled: (id: string) =>
        id === 'blocked' ? { traceId: 'blocked', error: permanent } : undefined,
    } as unknown as ConnectionManager;
    const connector = new GuildDbConnector(containerWith(factory, cm), 'mongodb://x', silent);
    const guilds = new Map<string, GuildInfo>([
      ['missing', { bot_name: '', guild: fakeGuild('missing') }],
      ['healthy', { bot_name: '', guild: fakeGuild('healthy'), repos }],
      ['blocked', { bot_name: '', guild: fakeGuild('blocked') }],
    ]);
    const recovered = vi.fn(async (id: string) => {
      expect(guilds.get(id)?.repos).toBe(repos);
    });
    try {
      connector.startRecovery(
        guilds,
        (id, value) => {
          guilds.set(id, { ...guilds.get(id)!, repos: value });
        },
        recovered,
        100,
      );
      await vi.advanceTimersByTimeAsync(300);
      expect(factory).toHaveBeenCalledExactlyOnceWith('missing');
      expect(recovered).toHaveBeenCalledExactlyOnceWith('missing');
    } finally {
      connector.stopRecovery();
      vi.useRealTimers();
    }
  });

  it('retries failed passes without overlap and never publishes after shutdown', async () => {
    vi.useFakeTimers();
    let finish!: (repos: Repos) => void;
    const factory = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(
        () =>
          new Promise<Repos>((resolve) => {
            finish = resolve;
          }),
      );
    const connector = new GuildDbConnector(containerWith(factory), 'mongodb://x', silent);
    const guilds = new Map<string, GuildInfo>([
      ['missing', { bot_name: '', guild: fakeGuild('missing') }],
    ]);
    const attach = vi.fn();
    const recovered = vi.fn(async () => {});
    try {
      connector.startRecovery(guilds, attach, recovered, 100);
      await vi.advanceTimersByTimeAsync(1000);
      expect(factory).toHaveBeenCalledTimes(2);
      connector.stopRecovery();
      finish(fakeRepos());
      await vi.advanceTimersByTimeAsync(1000);
      expect(attach).not.toHaveBeenCalled();
      expect(recovered).not.toHaveBeenCalled();
      expect(factory).toHaveBeenCalledTimes(2);
    } finally {
      connector.stopRecovery();
      vi.useRealTimers();
    }
  });
});
