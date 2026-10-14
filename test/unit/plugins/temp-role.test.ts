/**
 * Unit tests for the temp-role plugin internals.
 *
 * The functions take a typed `TempRoleDeps` bundle, so these tests
 * inject a fake clock, registry, repos, and Discord client without any
 * handler-registry or real Discord / Mongo wiring.
 */
import type { Job } from 'node-schedule';
import { DiscordAPIError } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { err, ok } from '../../../src/core/result';
import { createLogger } from '../../../src/core/logger';
import { systemClock, createFakeClock } from '../../../src/core/time';
import { createContainer } from '../../../src/core/ioc';
import { TOKENS } from '../../../src/bot/tokens';
import { databaseErrorFrom } from '../../../src/persistence/error-translator';
import type { PluginRuntimeContext } from '../../../src/core/plugin';
import { createTempRolePlugin } from '../../../src/plugins/temp-role';
import {
  cancelTempRole,
  createTempRole,
  expireTempRole,
  rebootTempRoleJobs,
  tempRoleJobKey,
  MAX_GUILD_ROLES,
  type TempRoleDeps,
} from '../../../src/application/temp-role/temp-role';
import { buildGuild, buildGuildRoles } from '../../fixtures/discord/guild-builder';
import { buildSendableChannel } from '../../fixtures/discord/channel-builder';
import type { GuildRegistry } from '../../../src/bot/guild-registry';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// A fixed point well in the real future so node-schedule (which runs on
// the real system clock, not the injected fake clock) returns a live,
// cancellable Job rather than null for a past date.
const BASE_NOW = 4_102_444_800_000; // 2100-01-01T00:00:00Z

const silent = createLogger({ level: 'silent', pretty: false });
const translator = { t: (k: string) => k } as unknown as TempRoleDeps['translator'];

const dbErr = () => err(databaseErrorFrom(new Error('boom'), { operation: 'test' }));

interface FakeReposOverrides {
  create?: ReturnType<typeof vi.fn>;
  findByRoleId?: ReturnType<typeof vi.fn>;
  deleteByRoleId?: ReturnType<typeof vi.fn>;
  listAll?: ReturnType<typeof vi.fn>;
}

const makeRepos = (overrides: FakeReposOverrides = {}) => ({
  tempRole: {
    create: overrides.create ?? vi.fn().mockResolvedValue(ok({ role_id: 'role-1' })),
    findByRoleId: overrides.findByRoleId ?? vi.fn().mockResolvedValue(ok(undefined)),
    deleteByRoleId: overrides.deleteByRoleId ?? vi.fn().mockResolvedValue(ok(true)),
    listAll: overrides.listAll ?? vi.fn().mockResolvedValue(ok([])),
  },
});

/**
 * Guild / channel stand-ins for the create path. The spies come back
 * alongside the typed value so assertions and `mockRejectedValue` reach
 * them without casting the Discord type open again.
 */
const makeGuild = (roleCount: number) => {
  const roles = buildGuildRoles({ roleCount });
  return { guild: buildGuild({ id: 'g1', roles }), roles };
};

const makeChannel = (sendable: boolean) => buildSendableChannel({ sendable });

// Track every job map handed out so afterEach can cancel real
// node-schedule timers and keep them from leaking past a test.
const createdJobMaps: Map<string, Job>[] = [];

interface MakeDepsOpts {
  repos?: unknown;
  clock?: TempRoleDeps['clock'];
  guilds?: Map<string, unknown>;
  listGuildIds?: readonly string[];
  getChannel?: () => unknown;
  jobMap?: Map<string, Job>;
}

const makeDeps = (opts: MakeDepsOpts = {}): TempRoleDeps => {
  const jobMap = opts.jobMap ?? new Map<string, Job>();
  createdJobMaps.push(jobMap);
  return {
    client: {
      guilds: { cache: opts.guilds ?? new Map() },
      channels: { fetch: vi.fn().mockResolvedValue(null) },
    },
    registry: {
      getRepos: () => opts.repos,
      getChannel: opts.getChannel ?? (() => undefined),
      getRole: () => undefined,
      listGuildIds: () => opts.listGuildIds ?? [],
    },
    jobMap,
    logger: silent,
    translator,
    clock: opts.clock ?? createFakeClock(BASE_NOW),
  } as unknown as TempRoleDeps;
};

afterEach(() => {
  for (const jm of createdJobMaps) {
    // node-schedule returns null for a past date; guard so cleanup of a
    // pre-seeded fake job or a live job both work.
    for (const job of jm.values()) job?.cancel();
  }
  createdJobMaps.length = 0;
  vi.clearAllMocks();
});

describe('createTempRole', () => {
  it('returns role_limit at the guild role ceiling and creates no role', async () => {
    const deps = makeDeps({ repos: makeRepos() });
    const { guild, roles } = makeGuild(MAX_GUILD_ROLES);
    const { channel } = makeChannel(true);

    const outcome = await createTempRole(deps, {
      guild,
      channel,
      creatorId: 'u1',
      roleName: 'Notify',
      days: 7,
      maxActivePerMember: 3,
    });

    expect(outcome.status).toBe('role_limit');
    expect(roles.create).not.toHaveBeenCalled();
  });

  it('returns no_db when the guild has no repository hookup', async () => {
    const deps = makeDeps({ repos: undefined });
    const { guild, roles } = makeGuild(10);
    const { channel } = makeChannel(true);

    const outcome = await createTempRole(deps, {
      guild,
      channel,
      creatorId: 'u1',
      roleName: 'Notify',
      days: 7,
      maxActivePerMember: 3,
    });

    expect(outcome.status).toBe('no_db');
    expect(roles.create).not.toHaveBeenCalled();
  });

  it('refuses a member who already has the most active temp roles', async () => {
    const repos = makeRepos({
      listAll: vi.fn().mockResolvedValue(
        ok([
          { creator_id: 'u1', role_name: '🔔 Existing one' },
          { creator_id: 'u1', role_name: '🔔 Existing two' },
        ]),
      ),
    });
    const { guild, roles } = makeGuild(10);
    const { channel } = makeChannel(true);

    const outcome = await createTempRole(makeDeps({ repos }), {
      guild,
      channel,
      creatorId: 'u1',
      roleName: 'Notify',
      days: 7,
      maxActivePerMember: 2,
    });

    expect(outcome).toEqual({ status: 'too_many', max: 2 });
    expect(roles.create).not.toHaveBeenCalled();
  });

  it('refuses a name an existing role already uses', async () => {
    const roles = buildGuildRoles({ roles: [{ id: 'r-mod', name: 'Moderator' }] });
    const guild = buildGuild({ id: 'g1', roles });
    const { channel } = makeChannel(true);

    const outcome = await createTempRole(makeDeps({ repos: makeRepos() }), {
      guild,
      channel,
      creatorId: 'u1',
      roleName: 'moderator',
      days: 7,
      maxActivePerMember: 3,
    });

    expect(outcome).toEqual({ status: 'name_taken' });
    expect(roles.create).not.toHaveBeenCalled();
  });

  it('enforces the member cap across concurrent creates', async () => {
    const stored: { creator_id: string; role_name: string }[] = [];
    const repos = makeRepos({
      listAll: vi.fn(async () => ok([...stored])),
      create: vi.fn(async (doc: { creator_id: string; role_name: string }) => {
        stored.push(doc);
        return ok(doc);
      }),
    });
    const deps = makeDeps({ repos });
    const { guild, roles } = makeGuild(10);
    const { channel } = makeChannel(true);
    const request = { guild, channel, creatorId: 'u1', days: 7, maxActivePerMember: 1 };

    const outcomes = await Promise.all([
      createTempRole(deps, { ...request, roleName: 'First' }),
      createTempRole(deps, { ...request, roleName: 'Second' }),
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['created', 'too_many']);
    expect(roles.create).toHaveBeenCalledTimes(1);
    expect(stored).toHaveLength(1);
  });

  it('rejects concurrent duplicate names even before a client cache catches up', async () => {
    const stored: { creator_id: string; role_name: string }[] = [];
    const repos = makeRepos({
      listAll: vi.fn(async () => ok([...stored])),
      create: vi.fn(async (doc: { creator_id: string; role_name: string }) => {
        stored.push(doc);
        return ok(doc);
      }),
    });
    const deps = makeDeps({ repos });
    const first = makeGuild(10);
    const second = makeGuild(10);
    const { channel } = makeChannel(true);
    const request = { channel, days: 7, maxActivePerMember: 3 };

    const outcomes = await Promise.all([
      createTempRole(deps, { ...request, guild: first.guild, creatorId: 'u1', roleName: 'Notify' }),
      createTempRole(deps, {
        ...request,
        guild: second.guild,
        creatorId: 'u2',
        roleName: 'notify',
      }),
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['created', 'name_taken']);
    expect(first.roles.create).toHaveBeenCalledTimes(1);
    expect(second.roles.create).not.toHaveBeenCalled();
  });

  it('releases the guild creation queue after a failed request', async () => {
    const deps = makeDeps({ repos: makeRepos() });
    const { guild, roles } = makeGuild(10);
    const { channel } = makeChannel(true);
    roles.create.mockRejectedValueOnce(new Error('Discord unavailable'));
    const request = {
      guild,
      channel,
      creatorId: 'u1',
      roleName: 'Notify',
      days: 7,
      maxActivePerMember: 3,
    };

    const outcomes = await Promise.allSettled([
      createTempRole(deps, request),
      createTempRole(deps, request),
    ]);

    expect(outcomes[0]?.status).toBe('rejected');
    expect(outcomes[1]).toEqual(
      expect.objectContaining({
        status: 'fulfilled',
        value: expect.objectContaining({ status: 'created' }),
      }),
    );
    expect(roles.create).toHaveBeenCalledTimes(2);
  });

  it('creates a permission-less mentionable role, persists it, and schedules expiry', async () => {
    const repos = makeRepos();
    const deps = makeDeps({ repos });
    const { guild, roles } = makeGuild(10);
    const { channel, send } = makeChannel(true);

    const outcome = await createTempRole(deps, {
      guild,
      channel,
      creatorId: 'u1',
      roleName: 'Notify',
      days: 7,
      maxActivePerMember: 3,
    });

    const expectedExpiry = BASE_NOW + 7 * MS_PER_DAY;
    expect(outcome).toEqual({ status: 'created', roleId: 'role-1', expiresAt: expectedExpiry });
    expect(roles.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '🔔 Notify',
        mentionable: true,
        permissions: [],
        reason: 'Temporary notification role created via /role temp create by u1',
      }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(repos.tempRole.create).toHaveBeenCalledWith(
      expect.objectContaining({
        role_id: 'role-1',
        channel_id: 'chan-1',
        message_id: 'msg-1',
        creator_id: 'u1',
        role_name: '🔔 Notify',
        expires_at: expectedExpiry,
      }),
    );
    expect(deps.jobMap.has(tempRoleJobKey('role-1'))).toBe(true);
  });

  it('deletes the orphan role when the announcement fails', async () => {
    const repos = makeRepos();
    const deps = makeDeps({ repos });
    const { guild, roles } = makeGuild(10);
    const { channel } = makeChannel(false); // not sendable -> announce returns null

    const outcome = await createTempRole(deps, {
      guild,
      channel,
      creatorId: 'u1',
      roleName: 'Notify',
      days: 7,
      maxActivePerMember: 3,
    });

    expect(outcome.status).toBe('announce_failed');
    expect(roles.delete).toHaveBeenCalledWith('role-1', expect.any(String));
    expect(repos.tempRole.create).not.toHaveBeenCalled();
  });

  it('rolls back the role + message and rethrows when persistence fails', async () => {
    const repos = makeRepos({ create: vi.fn().mockResolvedValue(dbErr()) });
    const deps = makeDeps({ repos });
    const { guild, roles } = makeGuild(10);
    const { channel, message } = makeChannel(true);

    await expect(
      createTempRole(deps, {
        guild,
        channel,
        creatorId: 'u1',
        roleName: 'Notify',
        days: 7,
        maxActivePerMember: 3,
      }),
    ).rejects.toBeDefined();

    expect(roles.delete).toHaveBeenCalledWith('role-1', expect.any(String));
    expect(message.delete).toHaveBeenCalledTimes(1);
    expect(deps.jobMap.has(tempRoleJobKey('role-1'))).toBe(false);
  });

  it('maps a Discord max-roles rejection to role_limit', async () => {
    const repos = makeRepos();
    const deps = makeDeps({ repos });
    const { guild, roles } = makeGuild(10); // cache lags below the ceiling
    const { channel } = makeChannel(true);
    // Discord rejects at the hard 250-role ceiling the cache missed.
    const maxRolesError = Object.create(DiscordAPIError.prototype) as DiscordAPIError;
    (maxRolesError as { code: number }).code = 30005;
    roles.create.mockRejectedValue(maxRolesError);

    const outcome = await createTempRole(deps, {
      guild,
      channel,
      creatorId: 'u1',
      roleName: 'Notify',
      days: 7,
      maxActivePerMember: 3,
    });

    expect(outcome.status).toBe('role_limit');
    expect(repos.tempRole.create).not.toHaveBeenCalled();
  });
});

describe('expireTempRole', () => {
  const makeExpiringDeps = (overrides: FakeReposOverrides = {}) => {
    const editableMessage = { edit: vi.fn().mockResolvedValue(undefined) };
    const guild = {
      id: 'g1',
      roles: { delete: vi.fn().mockResolvedValue(undefined) },
      channels: {
        cache: new Map([
          [
            'chan-1',
            {
              isTextBased: () => true,
              messages: { fetch: vi.fn().mockResolvedValue(editableMessage) },
            },
          ],
        ]),
      },
    };
    const repos = makeRepos(overrides);
    const deps = makeDeps({ repos, guilds: new Map([['g1', guild]]) });
    return { deps, repos, guild, editableMessage };
  };

  it('cancels the job, deletes the role, edits the claim message, and removes the row', async () => {
    const doc = {
      role_id: 'role-1',
      channel_id: 'chan-1',
      message_id: 'msg-1',
      role_name: 'Notify',
    };
    const { deps, repos, guild, editableMessage } = makeExpiringDeps({
      findByRoleId: vi.fn().mockResolvedValue(ok(doc)),
    });
    const fakeJob = { cancel: vi.fn() } as unknown as Job;
    deps.jobMap.set(tempRoleJobKey('role-1'), fakeJob);

    await expireTempRole(deps, 'g1', 'role-1');

    expect(fakeJob.cancel).toHaveBeenCalledTimes(1);
    expect(deps.jobMap.has(tempRoleJobKey('role-1'))).toBe(false);
    expect(guild.roles.delete).toHaveBeenCalledWith('role-1', expect.any(String));
    expect(editableMessage.edit).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
    expect(repos.tempRole.deleteByRoleId).toHaveBeenCalledWith('role-1');
  });

  it('tolerates a missing doc but still deletes the role and row', async () => {
    const { deps, repos, guild } = makeExpiringDeps({
      findByRoleId: vi.fn().mockResolvedValue(ok(undefined)),
    });

    await expireTempRole(deps, 'g1', 'role-1');

    expect(guild.roles.delete).toHaveBeenCalledWith('role-1', expect.any(String));
    expect(repos.tempRole.deleteByRoleId).toHaveBeenCalledWith('role-1');
  });

  it('rethrows when the row delete fails so a reboot sweep retries it', async () => {
    const { deps } = makeExpiringDeps({
      findByRoleId: vi.fn().mockResolvedValue(ok(undefined)),
      deleteByRoleId: vi.fn().mockResolvedValue(dbErr()),
    });

    await expect(expireTempRole(deps, 'g1', 'role-1')).rejects.toBeDefined();
  });

  it('preserves the row and job when Discord refuses role deletion', async () => {
    const { deps, repos, guild } = makeExpiringDeps({
      findByRoleId: vi.fn().mockResolvedValue(ok(undefined)),
    });
    guild.roles.delete.mockRejectedValue(new Error('missing permissions'));
    const fakeJob = { cancel: vi.fn() } as unknown as Job;
    deps.jobMap.set(tempRoleJobKey('role-1'), fakeJob);

    await expect(expireTempRole(deps, 'g1', 'role-1')).resolves.toBe(false);
    expect(repos.tempRole.deleteByRoleId).not.toHaveBeenCalled();
    expect(fakeJob.cancel).not.toHaveBeenCalled();
    expect(deps.jobMap.get(tempRoleJobKey('role-1'))).toBe(fakeJob);
  });

  it('keeps tracking when the guild is unavailable', async () => {
    const repos = makeRepos();
    const deps = makeDeps({ repos, guilds: new Map() });
    const fakeJob = { cancel: vi.fn() } as unknown as Job;
    deps.jobMap.set(tempRoleJobKey('role-1'), fakeJob);

    await expect(expireTempRole(deps, 'g1', 'role-1')).resolves.toBe(false);
    expect(repos.tempRole.deleteByRoleId).not.toHaveBeenCalled();
    expect(fakeJob.cancel).not.toHaveBeenCalled();
    expect(deps.jobMap.get(tempRoleJobKey('role-1'))).toBe(fakeJob);
  });

  it('tolerates a missing claim channel and still removes the row', async () => {
    const doc = {
      role_id: 'role-1',
      channel_id: 'gone',
      message_id: 'msg-1',
      role_name: 'Notify',
    };
    const guild = {
      id: 'g1',
      roles: { delete: vi.fn().mockResolvedValue(undefined) },
      channels: { cache: new Map() },
    };
    const repos = makeRepos({ findByRoleId: vi.fn().mockResolvedValue(ok(doc)) });
    const deps = makeDeps({ repos, guilds: new Map([['g1', guild]]) });

    await expect(expireTempRole(deps, 'g1', 'role-1')).resolves.toBe(true);
    expect(guild.roles.delete).toHaveBeenCalledWith('role-1', expect.any(String));
    expect(repos.tempRole.deleteByRoleId).toHaveBeenCalledWith('role-1');
  });
});

describe('rebootTempRoleJobs', () => {
  it('rebuilds expiry jobs only for the recovered guild', async () => {
    const repos = makeRepos({
      listAll: vi
        .fn()
        .mockResolvedValue(ok([{ role_id: 'recovered-role', expires_at: BASE_NOW + MS_PER_DAY }])),
    });
    const deps = makeDeps({ repos, listGuildIds: ['healthy', 'recovered'] });
    const getRepos = vi.spyOn(deps.registry, 'getRepos');
    const container = createContainer();
    container.registerSingleton(TOKENS.DiscordClient, () => deps.client);
    container.registerSingleton(TOKENS.GuildRegistry, () => deps.registry as GuildRegistry);
    container.registerSingleton(TOKENS.JobMap, () => deps.jobMap);
    const ctx: PluginRuntimeContext = {
      logger: deps.logger,
      translator: { t: (k: string) => k } as PluginRuntimeContext['translator'],
      clock: deps.clock,
      resolve: container.resolve.bind(container) as PluginRuntimeContext['resolve'],
    };

    await createTempRolePlugin().onGuildDatabaseReady?.(ctx, 'recovered');

    expect(getRepos).toHaveBeenCalledExactlyOnceWith('recovered');
    expect(deps.jobMap.has(tempRoleJobKey('recovered-role'))).toBe(true);
  });

  it('reschedules a still-pending role and immediately expires a past-due one', async () => {
    const future = {
      role_id: 'future',
      channel_id: 'chan-1',
      message_id: 'm-future',
      role_name: 'Future',
      expires_at: BASE_NOW + 10_000,
    };
    const past = {
      role_id: 'past',
      channel_id: 'chan-1',
      message_id: 'm-past',
      role_name: 'Past',
      expires_at: BASE_NOW - 10_000,
    };
    const repos = makeRepos({
      listAll: vi.fn().mockResolvedValue(ok([future, past])),
      findByRoleId: vi.fn().mockResolvedValue(ok(past)),
    });
    const guild = {
      id: 'g1',
      roles: { delete: vi.fn().mockResolvedValue(undefined) },
      channels: { cache: new Map() },
    };
    const deps = makeDeps({
      repos,
      guilds: new Map([['g1', guild]]),
      listGuildIds: ['g1'],
    });

    await rebootTempRoleJobs(deps);

    expect(deps.jobMap.has(tempRoleJobKey('future'))).toBe(true);
    expect(deps.jobMap.has(tempRoleJobKey('past'))).toBe(false);
    expect(repos.tempRole.deleteByRoleId).toHaveBeenCalledWith('past');
    expect(repos.tempRole.deleteByRoleId).not.toHaveBeenCalledWith('future');
  });

  it('is a no-op for a guild with no repository hookup', async () => {
    const deps = makeDeps({ repos: undefined, listGuildIds: ['g1'] });
    await expect(rebootTempRoleJobs(deps)).resolves.toBeUndefined();
    expect(deps.jobMap.size).toBe(0);
  });

  it('notifies the debug channel when listAll keeps failing', async () => {
    const debugSend = vi.fn().mockResolvedValue(undefined);
    const repos = makeRepos({ listAll: vi.fn().mockRejectedValue(new Error('db down')) });
    const deps = makeDeps({
      repos,
      listGuildIds: ['g1'],
      getChannel: () => ({ isSendable: () => true, send: debugSend }),
    });

    await rebootTempRoleJobs(deps);

    expect(debugSend).toHaveBeenCalledTimes(1);
  });
});

describe('createTempRolePlugin', () => {
  const buildCtx = (): PluginRuntimeContext => {
    const container = createContainer();
    container.registerSingleton(TOKENS.GuildRegistry, () => ({
      getRepos: () => undefined,
      getChannel: () => undefined,
      getRole: () => undefined,
      listGuildIds: () => [],
    }));
    container.registerSingleton(
      TOKENS.DiscordClient,
      () => ({ user: { id: 'bot-1' }, guilds: { cache: new Map() } }) as never,
    );
    container.registerSingleton(TOKENS.JobMap, () => new Map());
    return {
      logger: silent,
      translator: { t: (k: string) => k } as PluginRuntimeContext['translator'],
      clock: systemClock,
      resolve: container.resolve.bind(container) as PluginRuntimeContext['resolve'],
    };
  };

  it('onReady runs to completion with an empty registry', async () => {
    const p = createTempRolePlugin();
    await expect(p.onReady?.(buildCtx())).resolves.toBeUndefined();
  });

  it('onReady swallows a reboot failure and logs it', async () => {
    const errorSpy = vi.fn();
    const container = createContainer();
    // The first dependency resolution throws, exercising onReady's catch.
    container.registerSingleton(TOKENS.DiscordClient, () => {
      throw new Error('resolve boom');
    });
    const ctx = {
      logger: { error: errorSpy } as unknown as PluginRuntimeContext['logger'],
      translator: { t: (k: string) => k } as PluginRuntimeContext['translator'],
      clock: systemClock,
      resolve: container.resolve.bind(container) as PluginRuntimeContext['resolve'],
    };

    await expect(createTempRolePlugin().onReady?.(ctx)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('cancelTempRole', () => {
  const doc = { role_id: 'role-1', creator_id: 'creator', channel_id: 'c', message_id: 'm' };

  it('lets the authority check refuse the requester', async () => {
    const repos = makeRepos({ findByRoleId: vi.fn().mockResolvedValue(ok(doc)) });

    const outcome = await cancelTempRole(makeDeps({ repos }), 'g1', 'role-1', () => false);

    expect(outcome).toEqual({ status: 'forbidden' });
    expect(repos.tempRole.deleteByRoleId).not.toHaveBeenCalled();
  });

  it('reports a role that is not a temp role', async () => {
    const outcome = await cancelTempRole(makeDeps({ repos: makeRepos() }), 'g1', 'x', () => true);

    expect(outcome).toEqual({ status: 'not_temp_role' });
  });

  it('retains the row and expiry job when Discord rejects cancellation', async () => {
    const repos = makeRepos({ findByRoleId: vi.fn().mockResolvedValue(ok(doc)) });
    const { guild, roles } = makeGuild(10);
    const deps = makeDeps({ repos, guilds: new Map([['g1', guild]]) });
    const fakeJob = { cancel: vi.fn() } as unknown as Job;
    deps.jobMap.set(tempRoleJobKey('role-1'), fakeJob);
    const error = new Error('Missing Permissions');
    roles.delete.mockRejectedValueOnce(error);

    await expect(cancelTempRole(deps, 'g1', 'role-1', () => true)).rejects.toBe(error);

    expect(repos.tempRole.deleteByRoleId).not.toHaveBeenCalled();
    expect(fakeJob.cancel).not.toHaveBeenCalled();
    expect(deps.jobMap.get(tempRoleJobKey('role-1'))).toBe(fakeJob);
    expect(deps.client.channels.fetch).not.toHaveBeenCalled();
  });

  it('retains tracking state when the guild is unavailable', async () => {
    const repos = makeRepos({ findByRoleId: vi.fn().mockResolvedValue(ok(doc)) });
    const deps = makeDeps({ repos });
    const fakeJob = { cancel: vi.fn() } as unknown as Job;
    deps.jobMap.set(tempRoleJobKey('role-1'), fakeJob);

    await expect(cancelTempRole(deps, 'g1', 'role-1', () => true)).rejects.toThrow(
      'unavailable guild',
    );

    expect(repos.tempRole.deleteByRoleId).not.toHaveBeenCalled();
    expect(fakeJob.cancel).not.toHaveBeenCalled();
  });

  it('finishes cancellation when Discord reports the role already removed', async () => {
    const repos = makeRepos({ findByRoleId: vi.fn().mockResolvedValue(ok(doc)) });
    const { guild, roles } = makeGuild(10);
    const deps = makeDeps({ repos, guilds: new Map([['g1', guild]]) });
    const fakeJob = { cancel: vi.fn() } as unknown as Job;
    deps.jobMap.set(tempRoleJobKey('role-1'), fakeJob);
    const error = Object.create(DiscordAPIError.prototype) as DiscordAPIError;
    (error as { code: number }).code = 10011;
    roles.delete.mockRejectedValueOnce(error);

    await expect(cancelTempRole(deps, 'g1', 'role-1', () => true)).resolves.toEqual({
      status: 'cancelled',
    });

    expect(repos.tempRole.deleteByRoleId).toHaveBeenCalledWith('role-1');
    expect(fakeJob.cancel).toHaveBeenCalledOnce();
    expect(deps.jobMap.has(tempRoleJobKey('role-1'))).toBe(false);
  });

  it('expires the role when the requester may cancel it', async () => {
    const repos = makeRepos({ findByRoleId: vi.fn().mockResolvedValue(ok(doc)) });

    const { guild, roles } = makeGuild(10);
    const outcome = await cancelTempRole(
      makeDeps({ repos, guilds: new Map([['g1', guild]]) }),
      'g1',
      'role-1',
      (creatorId) => creatorId === 'creator',
    );

    expect(outcome).toEqual({ status: 'cancelled' });
    expect(roles.delete).toHaveBeenCalledWith('role-1', expect.any(String));
    expect(repos.tempRole.deleteByRoleId).toHaveBeenCalledWith('role-1');
  });
});
