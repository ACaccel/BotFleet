/**
 * Unit tests for the identity-sync plugin: the config contract, the pure
 * apply routine (sync vs fallback, per-guild server-nickname mirroring,
 * avatar rate-limit guard, resilience + toggle branches), and the plugin's
 * schedule/cancel lifecycle.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Client, Guild, GuildMember } from 'discord.js';

import { createIdentitySyncPlugin } from '../../../src/plugins/identity-sync';
import { parseIdentitySyncConfig } from '../../../src/plugins/identity-sync/config';
import {
  runIdentitySync,
  type IdentitySyncState,
} from '../../../src/plugins/identity-sync/internal/sync';
import { TOKENS } from '../../../src/bot/tokens';
import { buildPluginContext, silentLogger } from '../../fixtures/runtime';

const silent = silentLogger();

const freshState = (): IdentitySyncState => ({
  lastSourceAvatarHash: null,
  fallbackApplied: false,
});

interface FakeOpts {
  /** Source user's GLOBAL avatar hash. */
  avatar?: string | null;
  /** The bot's current nickname in the guild (null = none set). */
  currentNick?: string | null;
  /** The source user's PER-GUILD display name (server nickname). */
  guildNick?: string;
  loggedIn?: boolean;
}

const makeClient = (opts: FakeOpts = {}) => {
  const setAvatar = vi.fn(async () => undefined);
  const setNickname = vi.fn(async () => undefined);
  const meMember = { nickname: opts.currentNick ?? null, setNickname } as unknown as GuildMember;
  const fetchMe = vi.fn(async () => meMember);
  // The SOURCE user's per-guild member. Its displayName is the server
  // nickname the bot should mirror — deliberately different from the global
  // `user.displayName` below so a regression that uses the global name fails.
  const sourceMember = { displayName: opts.guildNick ?? 'GuildNick' } as unknown as GuildMember;
  const fetchMember = vi.fn(async () => sourceMember);
  const guild = { id: 'g1', members: { me: meMember, fetchMe, fetch: fetchMember } };
  const user = {
    displayName: 'GlobalName', // global name — must NOT be used for the nickname
    avatar: opts.avatar === undefined ? 'hash-1' : opts.avatar,
    displayAvatarURL: () => 'https://cdn.invalid/a.png',
  };
  const fetchUser = vi.fn(async () => user);
  const client = {
    user: opts.loggedIn === false ? null : { setAvatar },
    users: { fetch: fetchUser },
    guilds: { cache: new Map([['g1', guild]]) },
  } as unknown as Client;
  return { client, setAvatar, setNickname, fetchUser, fetchMember };
};

const SYNC_CONFIG = parseIdentitySyncConfig({
  enabled: true,
  syncWithSource: true,
  sourceUserId: '789',
});

describe('parseIdentitySyncConfig', () => {
  it('fills safe defaults for an absent block', () => {
    expect(parseIdentitySyncConfig(undefined)).toEqual({
      enabled: false,
      syncWithSource: false,
      sourceUserId: '',
      schedule: '0 4 * * *',
      syncAvatar: true,
      syncNickname: true,
      fallbackNickname: '',
      fallbackAvatarPath: 'assets/gopher.png',
    });
  });

  it('rejects an unknown key (strict)', () => {
    expect(() => parseIdentitySyncConfig({ bogus: 1 })).toThrow();
  });

  it('requires sourceUserId when enabled and syncWithSource', () => {
    expect(() => parseIdentitySyncConfig({ enabled: true, syncWithSource: true })).toThrow();
    expect(() =>
      parseIdentitySyncConfig({ enabled: true, syncWithSource: true, sourceUserId: '789' }),
    ).not.toThrow();
  });
});

describe('runIdentitySync (sync mode)', () => {
  it("mirrors the source user's PER-GUILD nickname, not their global name", async () => {
    const { client, setAvatar, setNickname, fetchUser, fetchMember } = makeClient({
      avatar: 'hash-1',
      guildNick: '瑪約的收藏品',
    });
    const state = freshState();
    await runIdentitySync({ client, config: SYNC_CONFIG, logger: silent }, state);

    expect(fetchMember).toHaveBeenCalledWith('789');
    expect(setNickname).toHaveBeenCalledWith('瑪約的收藏品');
    expect(setNickname).not.toHaveBeenCalledWith('GlobalName');
    expect(fetchUser).toHaveBeenCalledWith('789');
    expect(setAvatar).toHaveBeenCalledWith('https://cdn.invalid/a.png');
    expect(state.lastSourceAvatarHash).toBe('hash-1');
  });

  it('does not re-upload the avatar when the source hash is unchanged', async () => {
    const { client, setAvatar } = makeClient({ avatar: 'hash-1' });
    const state: IdentitySyncState = { lastSourceAvatarHash: 'hash-1', fallbackApplied: false };
    await runIdentitySync({ client, config: SYNC_CONFIG, logger: silent }, state);
    expect(setAvatar).not.toHaveBeenCalled();
  });

  it('re-uploads the avatar when the source hash changed', async () => {
    const { client, setAvatar } = makeClient({ avatar: 'hash-2' });
    const state: IdentitySyncState = { lastSourceAvatarHash: 'hash-1', fallbackApplied: false };
    await runIdentitySync({ client, config: SYNC_CONFIG, logger: silent }, state);
    expect(setAvatar).toHaveBeenCalledTimes(1);
    expect(state.lastSourceAvatarHash).toBe('hash-2');
  });

  it('skips a no-op nickname change', async () => {
    const { client, setNickname } = makeClient({ currentNick: 'GuildNick' });
    await runIdentitySync({ client, config: SYNC_CONFIG, logger: silent }, freshState());
    expect(setNickname).not.toHaveBeenCalled();
  });

  it('is a no-op before login (client.user is null)', async () => {
    const { client, setAvatar, setNickname, fetchUser, fetchMember } = makeClient({
      loggedIn: false,
    });
    await runIdentitySync({ client, config: SYNC_CONFIG, logger: silent }, freshState());
    expect(fetchUser).not.toHaveBeenCalled();
    expect(fetchMember).not.toHaveBeenCalled();
    expect(setAvatar).not.toHaveBeenCalled();
    expect(setNickname).not.toHaveBeenCalled();
  });
});

describe('runIdentitySync (fallback mode)', () => {
  const fallbackConfig = parseIdentitySyncConfig({
    enabled: true,
    syncWithSource: false,
    fallbackNickname: 'Mouse',
    fallbackAvatarPath: 'assets/gopher.png',
  });

  it('applies the fallback nickname + avatar and never fetches a user', async () => {
    const { client, setAvatar, setNickname, fetchUser, fetchMember } = makeClient();
    const state = freshState();
    await runIdentitySync({ client, config: fallbackConfig, logger: silent }, state);

    expect(fetchUser).not.toHaveBeenCalled();
    expect(fetchMember).not.toHaveBeenCalled();
    expect(setNickname).toHaveBeenCalledWith('Mouse');
    expect(setAvatar).toHaveBeenCalledWith('assets/gopher.png');
    expect(state.fallbackApplied).toBe(true);
  });

  it('does not re-upload the fallback avatar once applied', async () => {
    const { client, setAvatar } = makeClient();
    const state: IdentitySyncState = { lastSourceAvatarHash: null, fallbackApplied: true };
    await runIdentitySync({ client, config: fallbackConfig, logger: silent }, state);
    expect(setAvatar).not.toHaveBeenCalled();
  });

  it('leaves the nickname untouched when fallbackNickname is empty', async () => {
    const emptyNick = parseIdentitySyncConfig({ enabled: true, syncWithSource: false });
    const { client, setNickname } = makeClient();
    await runIdentitySync({ client, config: emptyNick, logger: silent }, freshState());
    expect(setNickname).not.toHaveBeenCalled();
  });
});

describe('runIdentitySync (resilience + toggles)', () => {
  /** A guild with a cached bot member (whose setNickname is `selfNick`) and a source member. */
  const guildWith = (
    id: string,
    selfNick: ReturnType<typeof vi.fn>,
    sourceDisplayName = 'GuildNick',
  ): Guild => {
    const me = { nickname: null, setNickname: selfNick } as unknown as GuildMember;
    const source = { displayName: sourceDisplayName } as unknown as GuildMember;
    return {
      id,
      members: { me, fetchMe: vi.fn(async () => me), fetch: vi.fn(async () => source) },
    } as unknown as Guild;
  };

  const clientWith = (guilds: ReadonlyArray<readonly [string, Guild]>, setAvatar = vi.fn()) =>
    ({
      user: { setAvatar },
      users: {
        fetch: vi.fn(async () => ({
          displayName: 'GlobalName',
          avatar: 'hash-1',
          displayAvatarURL: () => 'https://cdn.invalid/a.png',
        })),
      },
      guilds: { cache: new Map(guilds) },
    }) as unknown as Client;

  it('isolates a per-guild nickname failure so other guilds still update', async () => {
    const badNick = vi.fn(async () => {
      throw new Error('Missing Permissions');
    });
    const okNick = vi.fn(async () => undefined);
    const client = clientWith([
      ['g1', guildWith('g1', badNick)],
      ['g2', guildWith('g2', okNick)],
    ]);
    await expect(
      runIdentitySync({ client, config: SYNC_CONFIG, logger: silent }, freshState()),
    ).resolves.toBeUndefined();
    expect(badNick).toHaveBeenCalledWith('GuildNick');
    expect(okNick).toHaveBeenCalledWith('GuildNick');
  });

  it('skips a guild where the source member cannot be fetched', async () => {
    const selfNick = vi.fn(async () => undefined);
    const me = { nickname: null, setNickname: selfNick } as unknown as GuildMember;
    const guild = {
      id: 'g1',
      members: {
        me,
        fetchMe: vi.fn(async () => me),
        fetch: vi.fn(async () => Promise.reject(new Error('Unknown Member'))),
      },
    } as unknown as Guild;
    await expect(
      runIdentitySync(
        { client: clientWith([['g1', guild]]), config: SYNC_CONFIG, logger: silent },
        freshState(),
      ),
    ).resolves.toBeUndefined();
    expect(selfNick).not.toHaveBeenCalled();
  });

  it('skips the avatar but still applies the nickname when the source user fetch fails', async () => {
    const { client, setAvatar, setNickname, fetchUser } = makeClient();
    fetchUser.mockRejectedValue(new Error('Unknown User'));
    await expect(
      runIdentitySync({ client, config: SYNC_CONFIG, logger: silent }, freshState()),
    ).resolves.toBeUndefined();
    expect(setAvatar).not.toHaveBeenCalled();
    expect(setNickname).toHaveBeenCalledWith('GuildNick');
  });

  it('survives a setAvatar failure and does not advance the recorded hash', async () => {
    const { client, setAvatar } = makeClient({ avatar: 'hash-2' });
    setAvatar.mockRejectedValue(new Error('rate limited'));
    const state: IdentitySyncState = { lastSourceAvatarHash: 'hash-1', fallbackApplied: false };
    await expect(
      runIdentitySync({ client, config: SYNC_CONFIG, logger: silent }, state),
    ).resolves.toBeUndefined();
    expect(state.lastSourceAvatarHash).toBe('hash-1');
  });

  it('clears the fallback marker after a successful source-avatar upload', async () => {
    const { client } = makeClient({ avatar: 'hash-9' });
    const state: IdentitySyncState = { lastSourceAvatarHash: null, fallbackApplied: true };
    await runIdentitySync({ client, config: SYNC_CONFIG, logger: silent }, state);
    expect(state.fallbackApplied).toBe(false);
  });

  it('clears the source hash after a successful fallback-avatar upload', async () => {
    const fallbackConfig = parseIdentitySyncConfig({
      enabled: true,
      syncWithSource: false,
      fallbackNickname: 'Mouse',
    });
    const { client } = makeClient();
    const state: IdentitySyncState = { lastSourceAvatarHash: 'stale', fallbackApplied: false };
    await runIdentitySync({ client, config: fallbackConfig, logger: silent }, state);
    expect(state.lastSourceAvatarHash).toBeNull();
  });

  it('respects syncAvatar=false (nickname only)', async () => {
    const cfg = parseIdentitySyncConfig({
      enabled: true,
      syncWithSource: true,
      sourceUserId: '789',
      syncAvatar: false,
    });
    const { client, setAvatar, setNickname } = makeClient();
    await runIdentitySync({ client, config: cfg, logger: silent }, freshState());
    expect(setAvatar).not.toHaveBeenCalled();
    expect(setNickname).toHaveBeenCalledWith('GuildNick');
  });

  it('respects syncNickname=false (avatar only)', async () => {
    const cfg = parseIdentitySyncConfig({
      enabled: true,
      syncWithSource: true,
      sourceUserId: '789',
      syncNickname: false,
    });
    const { client, setAvatar, setNickname, fetchMember } = makeClient();
    await runIdentitySync({ client, config: cfg, logger: silent }, freshState());
    expect(setNickname).not.toHaveBeenCalled();
    expect(fetchMember).not.toHaveBeenCalled();
    expect(setAvatar).toHaveBeenCalledWith('https://cdn.invalid/a.png');
  });

  it('fetches the bot self member when it is not cached', async () => {
    const selfNick = vi.fn(async () => undefined);
    const fetchedMe = { nickname: null, setNickname: selfNick } as unknown as GuildMember;
    const fetchMe = vi.fn(async () => fetchedMe);
    const source = { displayName: 'GuildNick' } as unknown as GuildMember;
    const guild = {
      id: 'g1',
      members: { me: null, fetchMe, fetch: vi.fn(async () => source) },
    } as unknown as Guild;
    await runIdentitySync(
      { client: clientWith([['g1', guild]]), config: SYNC_CONFIG, logger: silent },
      freshState(),
    );
    expect(fetchMe).toHaveBeenCalledTimes(1);
    expect(selfNick).toHaveBeenCalledWith('GuildNick');
  });
});

describe('createIdentitySyncPlugin lifecycle', () => {
  const makeCtx = (client: Client, jobMap: Map<string, unknown>) =>
    buildPluginContext({
      logger: silent,
      services: [
        [TOKENS.DiscordClient, client],
        [TOKENS.JobMap, jobMap],
      ],
    });

  it('does not schedule a job when disabled', async () => {
    const jobMap = new Map<string, unknown>();
    const { client } = makeClient({ loggedIn: false });
    const plugin = createIdentitySyncPlugin({ enabled: false });
    await plugin.onReady?.(makeCtx(client, jobMap));
    expect(jobMap.size).toBe(0);
  });

  it('schedules a daily job when enabled and cancels it on shutdown', async () => {
    const jobMap = new Map<string, unknown>();
    // client.user null so the boot-time apply is a no-op; only scheduling is asserted.
    const { client } = makeClient({ loggedIn: false });
    const plugin = createIdentitySyncPlugin({
      enabled: true,
      syncWithSource: true,
      sourceUserId: '789',
    });
    await plugin.onReady?.(makeCtx(client, jobMap));
    expect(jobMap.has('identity-sync:daily')).toBe(true);

    await plugin.onShutdown?.(makeCtx(client, jobMap));
    expect(jobMap.has('identity-sync:daily')).toBe(false);
  });
});
