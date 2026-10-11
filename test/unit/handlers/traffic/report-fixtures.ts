/**
 * Fakes for the `/traffic` subcommand handlers: a statistics reader that
 * answers every requested `activity` section with deterministic data shaped
 * after the approved style-B mockups, a guild with channels, members, emoji and
 * stickers, and an interaction that records its replies. Free of vitest so a
 * render script can reuse it; tests wrap the pieces they need in spies.
 */
import { ChannelType, PermissionFlagsBits, StickerFormatType } from 'discord.js';
import type { ChatInputCommandInteraction, Guild } from 'discord.js';

import type { BaseBot } from '../../../../src/bot';
import {
  bucketKeysOf,
  type ArchiveChannelInfo,
  type StatsWindow,
} from '../../../../src/core/archive/stats';
import { createPermissionRankPolicy } from '../../../../src/core/plugin';
import { ok } from '../../../../src/core/result';
import type { Repos } from '../../../../src/persistence/repositories';
import type {
  AnyActivityQuery,
  AppUsageStats,
  ArchiveStatsRepo,
  TopReactedMessage,
} from '../../../../src/persistence/repositories/archive-stats.types';

const GUILD_ID = 'g1';
export const INVOKER_ID = 'u-invoker';
const MENTIONED_USER_ID = '100000000000000001';
const MENTIONED_CHANNEL_ID = '200000000000000001';
/** A cached channel above the invoker's rank, for mentions that must stay unnamed. */
const HIDDEN_CHANNEL_ID = '300000000000000003';

const MEMBER_NAMES = [
  '阿華',
  'Momo',
  'Kuro',
  '雪乃',
  'tako',
  'Leo',
  '小葵',
  '阿凱',
  'Yuki',
  '小夜',
];
const CHANNEL_NAMES = [
  '閒聊',
  '遊戲',
  '迷因',
  '音樂分享',
  '程式討論',
  '深夜聊天',
  '每週心得',
  '公告討論',
  '繪圖分享',
  '使用回饋',
];

/** Channels: c1–c10 text, `forum` with post `post-1`, thread `t1` under c1, `secret` (rank 2). */
const CHANNEL_RECORDS: readonly ArchiveChannelInfo[] = [
  ...CHANNEL_NAMES.map((name, i) => ({
    channelId: `c${i + 1}`,
    name,
    type: 0,
    access: i === 9 ? ('deleted' as const) : ('readable' as const),
  })),
  { channelId: 'forum', name: '創作論壇', type: 15, access: 'readable' },
  { channelId: 'post-1', name: '每週心得', type: 11, parentId: 'forum', access: 'readable' },
  { channelId: 't1', name: '本週話題', type: 11, parentId: 'c1', access: 'readable' },
  { channelId: 'secret', name: '幹部頻道', type: 0, access: 'readable' },
  // Archived private thread under c1: only an invoker with Manage Threads may count it.
  { channelId: 'pt1', name: '私人討論', type: 12, parentId: 'c1', access: 'readable' },
];

const wave = (n: number, base: number, seed: number): number[] =>
  Array.from({ length: n }, (_, i) => Math.max(0, Math.round(base + ((i * seed) % 17) - 8)));

const trendOf = (
  window: StatsWindow,
  granularity: 'hour' | 'day' | 'week',
  base: number,
  timeZone: string,
) =>
  bucketKeysOf(window, granularity, timeZone).map((key, i, all) => ({
    key,
    messages: wave(all.length, base, 7)[i] ?? 0,
  }));

const grid = (): number[][] =>
  Array.from({ length: 7 }, (_, d) =>
    Array.from({ length: 24 }, (_, h) => 4 + d + (h >= 18 ? 3 * h : h)),
  );

const hotMessages = (): TopReactedMessage[] => [
  {
    messageId: 'm1',
    channelId: 'c3',
    createdTimestamp: Date.UTC(2026, 9, 8, 13, 34),
    author: { id: 'a3', username: 'kuro' },
    content:
      '每次開會 **老闆** 說 <@100000000000000001> 「這個很簡單」||其實很難||，[點我](https://evil.example) 的時候，我的表情是這樣的對吧',
    edited: false,
    attachments: [],
    stickers: [],
    totalReactions: 486,
    reactions: [
      { key: '😂', name: '😂', count: 214 },
      { key: 'e1', emojiId: 'e1', name: 'pepe_laugh', count: 147 },
      { key: '😭', name: '😭', count: 62 },
    ],
  },
  {
    messageId: 'm2',
    channelId: 'c9',
    createdTimestamp: Date.UTC(2026, 9, 5, 10, 12),
    author: { id: 'a4', username: 'yukino', globalName: '雪乃' },
    content: '畫了一張秋天的社團合照\n大家找找看 <#200000000000000001> 有沒有自己 <:blob_hug:e3>',
    edited: true,
    attachments: [{ contentType: 'image/png' }],
    stickers: [],
    totalReactions: 352,
    reactions: [{ key: '👍', name: '👍', count: 201 }],
  },
  {
    messageId: 'm3',
    channelId: 'c2',
    createdTimestamp: Date.UTC(2026, 9, 7, 14, 5),
    author: { id: 'a2', username: 'momo' },
    content: '',
    edited: false,
    attachments: [{ contentType: 'image/png' }, { contentType: 'image/jpeg' }],
    stickers: [],
    totalReactions: 301,
    reactions: [{ key: '👍', name: '👍', count: 133 }],
  },
];

interface FakeStatsOptions {
  /** Messages the summary reports; 0 makes every report answer "no data". */
  readonly messages?: number;
  readonly appUses?: number;
  /** No full backup has completed yet (the rebuild note shows). */
  readonly rebuilding?: boolean;
  /** Replaces the text of the top message. */
  readonly hotContent?: string;
}

export interface StatsCall {
  readonly method: string;
  readonly channelIds?: readonly string[];
  readonly sections?: readonly string[];
  readonly authorId?: string;
  readonly excludeUserIds?: readonly string[];
}

/** A statistics reader whose `activity` fills every requested section; `calls` records scopes. */
export const fakeStatsRepo = (
  options: FakeStatsOptions = {},
): ArchiveStatsRepo & { readonly calls: StatsCall[] } => {
  const calls: StatsCall[] = [];
  const total = options.messages ?? 12_345;
  const activity = async (query: AnyActivityQuery) => {
    const s = query.sections;
    calls.push({
      method: 'activity',
      channelIds: query.scope.channelIds,
      sections: Object.keys(s),
      ...(s.summary?.authorId === undefined ? {} : { authorId: s.summary.authorId }),
      ...(s.partners?.excludeUserIds === undefined
        ? {}
        : { excludeUserIds: s.partners.excludeUserIds }),
    });
    const person = s.summary?.authorId !== undefined;
    const messages = person ? Math.round(total / 15) : total;
    const granularity = s.trend?.granularity ?? 'day';
    const report: Record<string, unknown> = {};
    if (s.summary)
      report.summary = {
        messages,
        activeMembers: 213,
        activeChannels: person ? 13 : 37,
        edited: Math.round(messages * 0.065),
        content: {
          media: 1820,
          files: 75,
          voice: 12,
          links: 960,
          stickers: 410,
          polls: 6,
          forwards: 88,
          replies: 3827,
        },
        previousMessages: Math.round(messages / 1.082),
      };
    if (s.trend)
      report.trend = {
        granularity,
        current: trendOf(query.window, granularity, messages / 20, query.timeZone),
        previous: query.previousWindow
          ? trendOf(query.previousWindow, granularity, messages / 22, query.timeZone)
          : undefined,
      };
    if (s.heatmap) report.heatmap = { cells: grid() };
    if (s.channels) {
      const rows =
        s.channels.fold === false
          ? [
              { channelId: 'c1', messages: 1640, name: '閒聊', deleted: false },
              { channelId: 't1', messages: 612, name: '本週話題', deleted: false },
            ]
          : CHANNEL_NAMES.map((name, i) => ({
              channelId: i === 6 ? 'post-1' : `c${i + 1}`,
              messages: 2104 - i * 170,
              name,
              deleted: false,
              ...(i === 6 ? { forum: { channelId: 'forum', name: '創作論壇' } } : {}),
            }));
      const shown = rows.slice(0, s.channels.limit ?? 10);
      const listed = shown.reduce((sum, row) => sum + row.messages, 0);
      report.channels =
        s.channels.fold === false
          ? { rows: shown, distinct: rows.length, total: listed }
          : { rows: shown, distinct: rows.length + 27, total: listed + 2611 };
    }
    if (s.authors)
      report.authors = {
        rows: MEMBER_NAMES.slice(0, s.authors.limit ?? 10).map((name, i) => ({
          userId: `a${i + 1}`,
          messages: 753 - i * 40,
          globalName: name,
        })),
        distinct: 213,
        total: total + 6615,
        ...(s.authors.rankOf === undefined
          ? {}
          : { subject: { userId: s.authors.rankOf, rank: 12, messages } }),
      };
    if (s.reactions)
      report.reactions = { total: 8901, top: [{ key: '👍', name: '👍', count: 1203 }] };
    if (s.retention)
      report.retention = {
        previousMembers: 198,
        currentMembers: 213,
        retained: 143,
        returningOrNew: 70,
        retentionRate: 143 / 198,
      };
    if (s.activeDays) report.activeDays = { activeDays: 24, longestStreak: 11, dayKeys: [] };
    if (s.partners)
      report.partners = {
        partners: MEMBER_NAMES.map((_, i) => ({
          userId: `a${i + 1}`,
          repliesTo: 30 - i * 3,
          repliesFrom: 28 - i * 2,
          mentionsTo: 8 - (i % 8),
          mentionsFrom: 6 - (i % 6),
          total: 72 - i * 6,
        })),
        totals: { repliesSent: 240, repliesReceived: 198, mentionsSent: 70, mentionsReceived: 96 },
      };
    if (s.topMessages)
      report.topMessages = hotMessages()
        .map((hot, i) =>
          i === 0 && options.hotContent !== undefined
            ? { ...hot, content: options.hotContent }
            : hot,
        )
        .slice(0, s.topMessages.limit);
    return ok(report as never);
  };
  const appUsage = async (
    window: StatsWindow,
    scope: { readonly channelIds: readonly string[] },
    opts: Parameters<ArchiveStatsRepo['appUsage']>[2] = {},
  ) => {
    calls.push({ method: 'appUsage', channelIds: scope.channelIds });
    const uses = options.appUses ?? 1690;
    const apps = [
      {
        applicationId: 'bot-a',
        globalName: 'Bot A',
        uses: 1204,
        commands: 1050,
        components: 154,
        modals: 0,
        users: 88,
      },
      {
        applicationId: 'bot-b',
        username: 'Bot B',
        uses: 310,
        commands: 310,
        components: 0,
        modals: 0,
        users: 41,
      },
      {
        applicationId: 'bot-c',
        username: 'Bot C',
        uses: 176,
        commands: 120,
        components: 48,
        modals: 8,
        users: 22,
      },
    ].filter((app) => opts.applicationId === undefined || app.applicationId === opts.applicationId);
    const stats: AppUsageStats = {
      uses:
        opts.userId !== undefined
          ? 33
          : opts.applicationId === undefined
            ? uses
            : (apps[0]?.uses ?? 0),
      users: 104,
      firstRecordAt: window.startMs + 3 * 86_400_000,
      apps: uses === 0 ? [] : apps,
      topUsers: MEMBER_NAMES.map((_, i) => ({ userId: `a${i + 1}`, uses: 96 - i * 6 })),
      ...(opts.trend === undefined
        ? {}
        : {
            trend: trendOf(window, opts.trend.granularity, 50, opts.trend.timeZone).map((b) => ({
              key: b.key,
              uses: b.messages,
            })),
          }),
      ...(opts.heatmap === undefined ? {} : { heatmap: { cells: grid() } }),
    };
    return ok(stats);
  };
  const readers: Pick<
    ArchiveStatsRepo,
    'reactionsGiven' | 'emojiUsage' | 'stickerUsage' | 'listChannels' | 'fullBackupCompleted'
  > = {
    reactionsGiven: async (_w, _u, scope) => {
      calls.push({ method: 'reactionsGiven', channelIds: scope.channelIds });
      return ok({
        total: 936,
        byEmoji: [{ key: 'e1', emojiId: 'e1', name: 'pepe_laugh', count: 300 }],
      });
    },
    emojiUsage: async (_w, ids) => {
      calls.push({ method: 'emojiUsage' });
      return ok(
        ids.map((emojiId, i) => ({
          emojiId,
          messageUses: i % 4 === 3 ? 0 : Math.max(1, 300 - i * 13),
          reactionUses: i % 4 === 3 ? 0 : Math.max(0, 200 - i * 9),
        })),
      );
    },
    stickerUsage: async (_w, ids) => {
      calls.push({ method: 'stickerUsage' });
      return ok(ids.map((stickerId, i) => ({ stickerId, uses: i % 5 === 4 ? 0 : 92 - i * 7 })));
    },
    listChannels: async () => ok(CHANNEL_RECORDS),
    fullBackupCompleted: async () => ok(options.rebuilding !== true),
  };
  // The single-purpose methods are not used by the commands; only `activity` is.
  return { calls, activity, appUsage, ...readers } as unknown as ArchiveStatsRepo & {
    readonly calls: StatsCall[];
  };
};

const channel = (id: string, name: string, type: ChannelType, parentId: string | null = null) => ({
  id,
  name,
  type,
  parentId,
  isThread: () => type === ChannelType.PublicThread || type === ChannelType.PrivateThread,
  permissionsFor: () => ({ has: (flag: bigint) => flag === PermissionFlagsBits.ViewChannel }),
});

const member = (id: string, displayName: string, bot = false, roleIds: readonly string[] = []) => ({
  id,
  displayName,
  user: { id, username: displayName, bot, displayAvatarURL: () => `https://cdn.example/${id}.png` },
  roles: { cache: new Map(roleIds.map((roleId) => [roleId, { id: roleId }])) },
});

interface FakeGuildOptions {
  readonly emoji?: number;
  readonly stickers?: number;
  /** Role IDs of the invoker; `staff` clears rank 2. */
  readonly invokerRoles?: readonly string[];
}

/** A guild whose live channels mirror {@link CHANNEL_RECORDS} (minus the deleted `c10`). */
export const fakeGuild = (options: FakeGuildOptions = {}): Guild => {
  const channels = new Map<string, unknown>([
    ...CHANNEL_RECORDS.filter((r) => r.channelId !== 'c10').map(
      (r) =>
        [
          r.channelId,
          channel(r.channelId, r.name ?? r.channelId, r.type ?? 0, r.parentId ?? null),
        ] as const,
    ),
    [MENTIONED_CHANNEL_ID, channel(MENTIONED_CHANNEL_ID, '活動公告', ChannelType.GuildText)],
    [HIDDEN_CHANNEL_ID, channel(HIDDEN_CHANNEL_ID, '幹部閒聊', ChannelType.GuildText)],
  ]);
  const members = new Map<string, unknown>([
    [INVOKER_ID, member(INVOKER_ID, '小明', false, options.invokerRoles)],
    [MENTIONED_USER_ID, member(MENTIONED_USER_ID, '阿華')],
    ...MEMBER_NAMES.slice(0, 5).map((name, i) => [`a${i + 1}`, member(`a${i + 1}`, name)] as const),
    ['bot-a', member('bot-a', 'Bot A', true)],
  ]);
  const emojiNames = [
    'pepe_laugh',
    'cat_ok',
    'blob_hug',
    'party_parrot',
    'kekw',
    'sad_cat',
    'thonk',
    'stonks',
  ];
  const emojis = new Map(
    Array.from({ length: options.emoji ?? 24 }, (_, i) => {
      const id = `e${i + 1}`;
      return [
        id,
        {
          id,
          name: `${emojiNames[i % emojiNames.length]}${i >= 8 ? i : ''}`,
          animated: i % 3 === 2,
        },
      ] as const;
    }),
  );
  const stickerNames = ['貓貓敬禮', '晚安啦', '笑到流淚', '加班中', '讚啦', '害羞', '衝啊', '震驚'];
  const stickers = new Map(
    Array.from({ length: options.stickers ?? 15 }, (_, i) => {
      const id = `s${i + 1}`;
      const format = i === 3 ? StickerFormatType.Lottie : StickerFormatType.PNG;
      return [
        id,
        {
          id,
          name: `${stickerNames[i % stickerNames.length]}${i >= 8 ? i : ''}`,
          format,
          url: `https://media.discordapp.net/stickers/${id}.png`,
        },
      ] as const;
    }),
  );
  return {
    id: GUILD_ID,
    name: '範例伺服器',
    channels: { cache: channels },
    members: { cache: members, fetch: async (id: string) => members.get(id) },
    roles: { cache: new Map([['r1', { id: 'r1', name: '管理員' }]]) },
    emojis: { cache: emojis },
    stickers: { cache: stickers },
    client: {
      users: {
        // A bot the client has seen outside this guild's member cache.
        cache: new Map([
          ['bot-elsewhere', { id: 'bot-elsewhere', username: 'Elsewhere', bot: true }],
        ]),
        fetch: async (id: string) => {
          if (id.startsWith('a')) return { id, username: `user-${id}`, globalName: null };
          throw new Error('Unknown User');
        },
      },
    },
  } as unknown as Guild;
};

export interface Reply {
  readonly content?: string;
  readonly embeds?: readonly { toJSON(): Record<string, unknown> }[];
  readonly files?: readonly { attachment: unknown; name?: string }[];
}

interface FakeInteractionOptions {
  readonly subcommand: string;
  readonly guild?: Guild | null;
  readonly channelId?: string;
  readonly values?: Readonly<Record<string, string | number | boolean>>;
  readonly channel?: string;
  readonly user?: { readonly id: string; readonly username: string };
  readonly app?: string;
}

export const fakeInteraction = (
  options: FakeInteractionOptions,
): { interaction: ChatInputCommandInteraction; replies: Reply[]; deferred: unknown[] } => {
  const replies: Reply[] = [];
  const deferred: unknown[] = [];
  const values = options.values ?? {};
  const interaction = {
    guild: options.guild === undefined ? fakeGuild() : options.guild,
    guildId: GUILD_ID,
    channelId: options.channelId ?? 'c1',
    user: { id: INVOKER_ID },
    deferred: false,
    replied: false,
    options: {
      getSubcommand: () => options.subcommand,
      getSubcommandGroup: () => null,
      get: (name: string) => (name in values ? { value: values[name] } : null),
      getChannel: () => ({ id: options.channel ?? 'c1' }),
      getBoolean: (name: string) => (typeof values[name] === 'boolean' ? values[name] : null),
      getUser: (name: string) =>
        name === 'app'
          ? options.app === undefined
            ? null
            : { id: options.app }
          : (options.user ?? { id: 'a2', username: 'momo' }),
      getMember: () => null,
    },
    deferReply: async (payload: unknown) => {
      deferred.push(payload);
      (interaction as { deferred: boolean }).deferred = true;
    },
    editReply: async (payload: Reply) => {
      replies.push(payload);
    },
    reply: async (payload: Reply) => {
      replies.push(payload);
    },
  };
  return { interaction: interaction as unknown as ChatInputCommandInteraction, replies, deferred };
};

/** `secret` is rank 2: only an invoker with the `staff` role may count it. */
const POLICY = createPermissionRankPolicy({
  [GUILD_ID]: { channels: { secret: 2, [HIDDEN_CHANNEL_ID]: 2 }, roles: { staff: 2 } },
});

export const fakeBot = (
  stats: ArchiveStatsRepo,
  t: (key: string, params?: Record<string, unknown>) => string = (key) => key,
): BaseBot =>
  ({
    translator: { t },
    logger: undefined,
    getRepos: () => ({ archiveStats: stats }) as unknown as Repos,
    permissionRankPolicy: POLICY,
  }) as unknown as BaseBot;
