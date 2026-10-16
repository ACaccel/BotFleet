/**
 * Privacy-invariant coverage for the `/traffic` visibility filter.
 *
 * The pure `resolveVisibleChannelIds` is driven with a REAL
 * `PermissionRankPolicy` and hand-built cache / `archive_channels` inputs for
 * every rule: the rank ceiling per reply audience, View Channel, archived
 * threads judged through their parent, private threads needing Manage Threads,
 * and deleted channels counted only when `@everyone` could view them. The
 * discord.js adapter `buildAllowedChannelSet` is checked against channel and
 * member fixtures so the permission bits reach the pure rules. A `public` reply
 * additionally needs every role that can view the command channel to view the
 * counted channel, and never counts a private thread.
 */
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';

import type { ArchiveChannelInfo } from '../../../../src/core/archive/stats';
import { createPermissionRankPolicy } from '../../../../src/core/plugin';
import { buildAllowedChannelSet } from '../../../../src/handlers/commands/traffic-shared/allowed-channels';
import {
  resolveVisibleChannelIds,
  type LiveChannelAccess,
  type VisibleChannelInput,
} from '../../../../src/handlers/commands/traffic-shared/visibility-filter';
import { buildTextChannel } from '../../../fixtures/discord/channel-builder';
import { buildGuild, buildGuildRoles } from '../../../fixtures/discord/guild-builder';
import { buildGuildMember } from '../../../fixtures/discord/member-builder';

const GUILD = 'g1';
const MEMBER = 'u1';

const policy = createPermissionRankPolicy({
  [GUILD]: {
    channels: { internal: 1, secret: 2, topsecret: 3, 'cat-secret': 2 },
    roles: { staff: 2 },
  },
});

const live = (
  type: number,
  options: Partial<Omit<LiveChannelAccess, 'type'>> = {},
): LiveChannelAccess => ({
  type,
  parentId: options.parentId ?? null,
  canView: options.canView ?? true,
  canManageThreads: options.canManageThreads ?? false,
  audienceCanView: options.audienceCanView ?? true,
});
const record = (
  channelId: string,
  fields: Partial<Omit<ArchiveChannelInfo, 'channelId'>> = {},
): ArchiveChannelInfo => ({ channelId, access: 'readable', ...fields });

const resolve = (
  overrides: Partial<VisibleChannelInput> & Pick<VisibleChannelInput, 'live'>,
): string[] =>
  [
    ...resolveVisibleChannelIds({
      records: [],
      mode: 'ephemeral',
      userRank: 2,
      commandChannelId: 'pub',
      channelRank: (channelId, ancestors) => policy.channelRank(GUILD, channelId, ancestors),
      ...overrides,
    }),
  ].sort();

describe('resolveVisibleChannelIds — rank ceiling', () => {
  const ranked = new Map<string, LiveChannelAccess>([
    ['pub', live(ChannelType.GuildText)],
    ['internal', live(ChannelType.GuildText)],
    ['secret', live(ChannelType.GuildText)],
    ['topsecret', live(ChannelType.GuildText)],
  ]);

  it('caps an ephemeral reply by the invoker rank only', () => {
    expect(resolve({ live: ranked, commandChannelId: 'pub' })).toEqual([
      'internal',
      'pub',
      'secret',
    ]);
  });

  it('caps a public reply by the lower of the invoker and command channel ranks', () => {
    expect(resolve({ live: ranked, mode: 'public', commandChannelId: 'pub' })).toEqual(['pub']);
    expect(resolve({ live: ranked, mode: 'public', commandChannelId: 'internal' })).toEqual([
      'internal',
      'pub',
    ]);
    // A command channel ranked above the invoker never lifts the ceiling.
    expect(resolve({ live: ranked, mode: 'public', commandChannelId: 'topsecret' })).toEqual([
      'internal',
      'pub',
      'secret',
    ]);
  });

  it('ranks a public command channel through its recorded ancestors when it is not cached', () => {
    const records = [
      record('archived-cmd', { type: ChannelType.PublicThread, parentId: 'secret' }),
    ];
    expect(
      resolve({
        live: ranked,
        records,
        mode: 'public',
        userRank: 3,
        commandChannelId: 'archived-cmd',
      }),
    ).toEqual(['archived-cmd', 'internal', 'pub', 'secret']);
  });

  it('inherits the rank of every ancestor (category > channel > thread)', () => {
    const nested = new Map<string, LiveChannelAccess>([
      ['cat-secret', live(ChannelType.GuildCategory)],
      ['under', live(ChannelType.GuildText, { parentId: 'cat-secret' })],
      ['thread', live(ChannelType.PublicThread, { parentId: 'under' })],
    ]);
    expect(resolve({ live: nested, userRank: 0 })).toEqual([]);
    // Categories hold no messages and are never listed.
    expect(resolve({ live: nested, userRank: 2 })).toEqual(['thread', 'under']);
  });
});

describe('resolveVisibleChannelIds — Discord access', () => {
  it('requires View Channel on a cached channel', () => {
    const channels = new Map([
      ['open', live(ChannelType.GuildText)],
      ['closed', live(ChannelType.GuildText, { canView: false })],
    ]);
    expect(resolve({ live: channels })).toEqual(['open']);
  });

  it('judges an archived thread missing from the cache through its live parent', () => {
    const channels = new Map([
      ['open', live(ChannelType.GuildText)],
      ['closed', live(ChannelType.GuildText, { canView: false })],
    ]);
    const records = [
      record('archived-open', { type: ChannelType.PublicThread, parentId: 'open' }),
      record('archived-closed', { type: ChannelType.PublicThread, parentId: 'closed' }),
      record('archived-orphan', { type: ChannelType.PublicThread }),
    ];
    expect(resolve({ live: channels, records })).toEqual(['archived-open', 'open']);
  });

  it('ranks an archived thread through the recorded parent chain', () => {
    const channels = new Map([['secret', live(ChannelType.GuildText)]]);
    const records = [record('archived', { type: ChannelType.PublicThread, parentId: 'secret' })];
    expect(resolve({ live: channels, records, userRank: 1 })).toEqual([]);
    expect(resolve({ live: channels, records, userRank: 2 })).toEqual(['archived', 'secret']);
  });

  it('counts a private thread only with Manage Threads on the parent', () => {
    const records = [
      record('private', { type: ChannelType.PrivateThread, parentId: 'parent' }),
      record('public', { type: ChannelType.PublicThread, parentId: 'parent' }),
    ];
    const without = new Map([['parent', live(ChannelType.GuildText)]]);
    const withManage = new Map([
      ['parent', live(ChannelType.GuildText, { canManageThreads: true })],
    ]);
    expect(resolve({ live: without, records })).toEqual(['parent', 'public']);
    expect(resolve({ live: withManage, records })).toEqual(['parent', 'private', 'public']);
    // A cached private thread follows the same rule.
    const cachedPrivate = new Map([
      ['parent', live(ChannelType.GuildText)],
      ['private-live', live(ChannelType.PrivateThread, { parentId: 'parent' })],
    ]);
    expect(resolve({ live: cachedPrivate })).toEqual(['parent']);
  });
});

describe('resolveVisibleChannelIds — deleted channels', () => {
  it('counts a deleted channel only when @everyone could view it and its rank passes', () => {
    const records = [
      record('gone-public', { access: 'deleted', type: 0, everyoneCanView: true }),
      record('gone-private', { access: 'deleted', type: 0, everyoneCanView: false }),
      record('gone-unknown', { access: 'deleted', type: 0 }),
      record('gone-ranked', {
        access: 'deleted',
        type: 0,
        parentId: 'cat-secret',
        everyoneCanView: true,
      }),
    ];
    expect(resolve({ live: new Map(), records, userRank: 0 })).toEqual(['gone-public']);
    expect(resolve({ live: new Map(), records, userRank: 2 })).toEqual([
      'gone-public',
      'gone-ranked',
    ]);
  });

  it('judges a thread of a deleted channel by the parent record and never counts a private one', () => {
    const records = [
      record('gone', { access: 'deleted', type: 0, everyoneCanView: true }),
      record('gone-hidden', { access: 'deleted', type: 0, everyoneCanView: false }),
      // The thread's own flag is ignored: it can lag behind its parent.
      record('thread', {
        type: ChannelType.PublicThread,
        parentId: 'gone',
        everyoneCanView: false,
      }),
      record('thread-hidden', {
        type: ChannelType.PublicThread,
        parentId: 'gone-hidden',
        everyoneCanView: true,
      }),
      record('private', { type: ChannelType.PrivateThread, parentId: 'gone' }),
    ];
    expect(resolve({ live: new Map(), records })).toEqual(['gone', 'thread']);
  });

  it('prefers the live cache over a stale deleted record', () => {
    const records = [record('back', { access: 'deleted', type: 0, everyoneCanView: false })];
    const channels = new Map([['back', live(ChannelType.GuildText)]]);
    expect(resolve({ live: channels, records })).toEqual(['back']);
  });
});

describe('resolveVisibleChannelIds — public audience coverage', () => {
  const both = (overrides: Parameters<typeof resolve>[0]) => ({
    ephemeral: resolve({ ...overrides, mode: 'ephemeral' }),
    public: resolve({ ...overrides, mode: 'public' }),
  });

  it('keeps an unranked role-gated channel out of a public reply', () => {
    const channels = new Map([
      ['pub', live(ChannelType.GuildText)],
      ['club', live(ChannelType.GuildText, { audienceCanView: false })],
    ]);
    expect(both({ live: channels })).toEqual({ ephemeral: ['club', 'pub'], public: ['pub'] });
  });

  it('never counts a private thread publicly, and judges a public thread by its parent audience', () => {
    const channels = new Map([
      ['pub', live(ChannelType.GuildText, { canManageThreads: true })],
      ['club', live(ChannelType.GuildText, { canManageThreads: true, audienceCanView: false })],
      ['private', live(ChannelType.PrivateThread, { parentId: 'pub' })],
      ['club-thread', live(ChannelType.PublicThread, { parentId: 'club' })],
    ]);
    expect(both({ live: channels })).toEqual({
      ephemeral: ['club', 'club-thread', 'private', 'pub'],
      public: ['pub'],
    });
  });

  it('counts a deleted channel in both modes only when @everyone could view it', () => {
    const records = [
      record('gone-public', { access: 'deleted', type: 0, everyoneCanView: true }),
      record('gone-private', { access: 'deleted', type: 0, everyoneCanView: false }),
    ];
    expect(both({ live: new Map(), records })).toEqual({
      ephemeral: ['gone-public'],
      public: ['gone-public'],
    });
  });

  it('treats an archived thread of unknown type as private', () => {
    const channels = new Map([
      ['managed', live(ChannelType.GuildText, { canManageThreads: true })],
      ['viewed', live(ChannelType.GuildText)],
    ]);
    const records = [
      record('unknown-managed', { parentId: 'managed' }),
      record('unknown-viewed', { parentId: 'viewed' }),
    ];
    expect(both({ live: channels, records })).toEqual({
      ephemeral: ['managed', 'unknown-managed', 'viewed'],
      public: ['managed', 'viewed'],
    });
  });

  it('fails closed on an uncached channel that is not recorded as deleted', () => {
    const records = [
      record('cat', { type: ChannelType.GuildCategory }),
      // Uncached but not deleted: the bot lost access, so its last flag is not trusted.
      record('lost', { type: 0, everyoneCanView: true }),
      record('untyped', { parentId: 'cat', everyoneCanView: true }),
    ];
    expect(both({ live: new Map(), records })).toEqual({ ephemeral: [], public: [] });
  });
});

describe('buildAllowedChannelSet — discord.js adapter', () => {
  const staff = buildGuildMember({ id: MEMBER, roleIds: ['staff'] });
  const guild = () => {
    const parent = buildTextChannel({
      id: 'parent',
      permissionsBySubject: {
        [MEMBER]: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageThreads],
      },
    });
    const viewOnly = buildTextChannel({
      id: 'view-only',
      permissionsBySubject: { [MEMBER]: [PermissionFlagsBits.ViewChannel] },
    });
    const hidden = buildTextChannel({ id: 'hidden', viewableByAll: false });
    const secret = buildTextChannel({ id: 'topsecret', viewableByAll: true });
    return buildGuild({
      id: GUILD,
      everyoneRoleId: 'everyone',
      channels: [parent, viewOnly, hidden, secret],
    });
  };

  it('feeds View Channel, Manage Threads and the member rank into the rules', () => {
    const allowed = buildAllowedChannelSet({
      guild: guild(),
      member: staff,
      policy,
      mode: 'ephemeral',
      commandChannelId: 'parent',
      records: [
        record('p-private', { type: ChannelType.PrivateThread, parentId: 'parent' }),
        record('v-private', { type: ChannelType.PrivateThread, parentId: 'view-only' }),
        record('v-public', { type: ChannelType.PublicThread, parentId: 'view-only' }),
        record('h-public', { type: ChannelType.PublicThread, parentId: 'hidden' }),
        record('deleted', { access: 'deleted', type: 0, everyoneCanView: true }),
      ],
    });
    // topsecret (rank 3) exceeds the staff rank 2; hidden lacks View Channel.
    expect([...allowed].sort()).toEqual([
      'deleted',
      'p-private',
      'parent',
      'v-public',
      'view-only',
    ]);
  });

  it('caps a public reply by the command channel rank', () => {
    const allowed = buildAllowedChannelSet({
      guild: guild(),
      member: buildGuildMember({ id: MEMBER, roleIds: ['staff'] }),
      policy,
      mode: 'public',
      commandChannelId: 'parent',
      records: [record('secret', { access: 'deleted', type: 0, everyoneCanView: true })],
    });
    expect(allowed.has('secret')).toBe(false);
    expect(allowed.has('parent')).toBe(true);
  });

  it('drops a public reply channel some command channel readers cannot view', () => {
    const view = [PermissionFlagsBits.ViewChannel];
    const audienceGuild = buildGuild({
      id: GUILD,
      roles: buildGuildRoles({
        roles: [
          { id: 'everyone', name: '@everyone' },
          { id: 'club', name: 'club' },
        ],
      }),
      channels: [
        buildTextChannel({
          id: 'lobby',
          permissionsBySubject: { everyone: view, club: view, [MEMBER]: view },
        }),
        buildTextChannel({ id: 'clubroom', permissionsBySubject: { club: view, [MEMBER]: view } }),
        buildTextChannel({
          id: 'open',
          permissionsBySubject: { everyone: view, club: view, [MEMBER]: view },
        }),
      ],
    });
    const allowed = (mode: 'ephemeral' | 'public', commandChannelId = 'lobby') =>
      [
        ...buildAllowedChannelSet({
          guild: audienceGuild,
          member: buildGuildMember({ id: MEMBER, roleIds: ['club'] }),
          policy,
          mode,
          commandChannelId,
          records: [],
        }),
      ].sort();
    expect(allowed('ephemeral')).toEqual(['clubroom', 'lobby', 'open']);
    expect(allowed('public')).toEqual(['lobby', 'open']);
    // An uncached command channel has an unknown audience: nothing live counts.
    expect(allowed('public', 'not-cached')).toEqual([]);
  });
});
