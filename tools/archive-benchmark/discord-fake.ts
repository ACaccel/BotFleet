import { ChannelType, type Client, type Guild, type GuildBasedChannel } from 'discord.js';
import { setTimeout as delay } from 'node:timers/promises';

const DISCORD_EPOCH = 1_420_070_400_000n;
const HISTORY_ROUTE = /^\/channels\/(\d+)\/messages$/;
const MESSAGE_ROUTE = /^\/channels\/(\d+)\/messages\/(\d+)$/;
const REACTION_ROUTE = /^\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/]+)$/;
const CHANNEL_ROUTE = /^\/channels\/(\d+)$/;

/** Route families the SDK keys its sequential handlers on, together with the channel. */
export type FakeRoute = 'messages' | 'message' | 'reactions' | 'channel' | 'other';

export const snowflakeAt = (ms: number, increment = 0): string =>
  (((BigInt(Math.floor(ms)) - DISCORD_EPOCH) << 22n) + BigInt(increment)).toString();

interface FakeReaction {
  readonly emoji: { readonly id: string | null; readonly name: string };
  normal: string[];
  burst: string[];
}
export interface FakeMessage {
  readonly id: string;
  readonly channelId: string;
  readonly createdAt: number;
  readonly reactions: FakeReaction[];
}
export interface FakeChannel {
  readonly id: string;
  readonly name: string;
  /** Requests for this channel share the SDK handlers of `bucketId` (segment simulation). */
  readonly bucketId: string;
}
export interface FakeDatasetOptions {
  readonly channels: readonly { readonly id: string; readonly messages: number }[];
  /** Share of messages with reactions. */
  readonly reactionRate: number;
  /** Newest message time; messages are spaced one second apart before it. */
  readonly endAt: number;
  readonly seed?: number;
}

/** Deterministic PRNG so every run sees the same synthetic guild. */
const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const EMOJI: readonly FakeReaction['emoji'][] = [
  { id: null, name: '👍' },
  { id: null, name: '😂' },
  { id: null, name: '🎉' },
  { id: '900000000000000001', name: 'party' },
  { id: '900000000000000002', name: 'wave' },
];
const userId = (index: number): string => `2${String(index).padStart(17, '0')}`;

/**
 * Messages for each channel, newest at `endAt`. A reacted message has one to three
 * emoji with one to six normal users; one in twenty lists 150 users (two pages) and
 * one in ten has a burst user.
 */
export const fakeMessages = (options: FakeDatasetOptions): FakeMessage[] => {
  const next = seededRandom(options.seed ?? 7);
  const messages: FakeMessage[] = [];
  let offset = 0;
  for (const channel of options.channels) {
    for (let index = 0; index < channel.messages; index += 1) {
      offset += 1;
      const createdAt = options.endAt - offset * 1000;
      const reactions: FakeReaction[] = [];
      if (next() < options.reactionRate) {
        const emoji = 1 + Math.floor(next() * 3);
        for (let slot = 0; slot < emoji; slot += 1) {
          const users = next() < 0.05 ? 150 : 1 + Math.floor(next() * 6);
          reactions.push({
            emoji: EMOJI[(offset + slot) % EMOJI.length]!,
            normal: Array.from({ length: users }, (_, user) => userId(user + slot * 1000)),
            burst: next() < 0.1 ? [userId(9000 + slot)] : [],
          });
        }
      }
      messages.push({
        id: snowflakeAt(createdAt, offset % 4096),
        channelId: channel.id,
        createdAt,
        reactions,
      });
    }
  }
  return messages;
};

const emojiRoute = (emoji: FakeReaction['emoji']): string =>
  emoji.id === null ? emoji.name : `${emoji.name}:${emoji.id}`;

/** The Discord message payload; `includeGuild` marks a Gateway MESSAGE_CREATE body. */
export const rawMessage = (
  message: FakeMessage,
  includeGuild = false,
): Record<string, unknown> => ({
  id: message.id,
  channel_id: message.channelId,
  ...(includeGuild ? { guild_id: '1' } : {}),
  type: 0,
  flags: 0,
  author: { id: '300000000000000001', username: 'member', global_name: 'Member', bot: false },
  content: `synthetic message ${message.id}`,
  timestamp: new Date(message.createdAt).toISOString(),
  edited_timestamp: null,
  tts: false,
  mention_everyone: false,
  mentions: [],
  mention_roles: [],
  attachments: [],
  embeds: [],
  pinned: false,
  ...(message.reactions.length === 0
    ? {}
    : {
        reactions: message.reactions.map((reaction) => ({
          emoji: reaction.emoji,
          count: reaction.normal.length + reaction.burst.length,
          count_details: { normal: reaction.normal.length, burst: reaction.burst.length },
          burst_colors: [],
          me: false,
          me_burst: false,
        })),
      }),
});

interface RequestOptions {
  readonly query?: URLSearchParams;
  readonly signal?: AbortSignal;
}

/**
 * A synthetic Discord REST owner that mirrors `@discordjs/rest`: requests of one
 * route family and channel (one SDK handler) run strictly one after another, each
 * taking `latencyMs`; different handlers run in parallel. No HTTP is sent.
 */
export class FakeDiscordRest {
  public readonly requests: Record<FakeRoute, number> = {
    messages: 0,
    message: 0,
    reactions: 0,
    channel: 0,
    other: 0,
  };
  private readonly handlers = new Map<string, Promise<void>>();
  private readonly messages = new Map<string, FakeMessage>();
  private readonly byChannel = new Map<string, FakeMessage[]>();
  private active = 0;
  public peakActive = 0;

  public constructor(
    private readonly channels: ReadonlyMap<string, FakeChannel>,
    messages: readonly FakeMessage[],
    private readonly latencyMs: number,
  ) {
    for (const message of messages) this.add(message);
  }

  public add(message: FakeMessage): void {
    this.messages.set(message.id, message);
    const list = this.byChannel.get(message.channelId) ?? [];
    list.push(message);
    list.sort((left, right) => (BigInt(left.id) < BigInt(right.id) ? 1 : -1));
    this.byChannel.set(message.channelId, list);
  }

  public message(id: string): FakeMessage | undefined {
    return this.messages.get(id);
  }

  public get total(): number {
    return Object.values(this.requests).reduce((sum, count) => sum + count, 0);
  }

  public readonly get = async (route: string, options: RequestOptions = {}): Promise<unknown> => {
    const { family, channelId } = this.classify(route);
    this.requests[family] += 1;
    const handler = `${family}:${this.channels.get(channelId)?.bucketId ?? channelId}`;
    const previous = this.handlers.get(handler) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => turn);
    this.handlers.set(handler, tail);
    await previous;
    this.active += 1;
    this.peakActive = Math.max(this.peakActive, this.active);
    try {
      await delay(this.latencyMs, undefined, { signal: options.signal });
      return this.respond(route, options.query);
    } finally {
      this.active -= 1;
      release();
      if (this.handlers.get(handler) === tail) this.handlers.delete(handler);
    }
  };

  public readonly patch = async (): Promise<unknown> => ({});

  private classify(route: string): { family: FakeRoute; channelId: string } {
    const reaction = REACTION_ROUTE.exec(route);
    if (reaction !== null) return { family: 'reactions', channelId: reaction[1]! };
    const message = MESSAGE_ROUTE.exec(route);
    if (message !== null) return { family: 'message', channelId: message[1]! };
    const history = HISTORY_ROUTE.exec(route);
    if (history !== null) return { family: 'messages', channelId: history[1]! };
    const channel = CHANNEL_ROUTE.exec(route);
    if (channel !== null) return { family: 'channel', channelId: channel[1]! };
    return { family: 'other', channelId: 'global' };
  }

  private respond(route: string, query?: URLSearchParams): unknown {
    const reaction = REACTION_ROUTE.exec(route);
    if (reaction !== null) {
      const message = this.messages.get(reaction[2]!);
      const emoji = decodeURIComponent(reaction[3]!);
      const found = message?.reactions.find((entry) => emojiRoute(entry.emoji) === emoji);
      if (message === undefined) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
      const users = (query?.get('type') === '1' ? found?.burst : found?.normal) ?? [];
      const after = query?.get('after');
      const limit = Number(query?.get('limit') ?? '25');
      return [...users]
        .sort((left, right) => (BigInt(left) < BigInt(right) ? -1 : 1))
        .filter((id) => after === undefined || after === null || BigInt(id) > BigInt(after))
        .slice(0, limit)
        .map((id) => ({ id, username: 'user' }));
    }
    const single = MESSAGE_ROUTE.exec(route);
    if (single !== null) {
      const message = this.messages.get(single[2]!);
      if (message === undefined) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
      return rawMessage(message);
    }
    const history = HISTORY_ROUTE.exec(route);
    if (history !== null) {
      const before = BigInt(query?.get('before') ?? '0');
      const limit = Number(query?.get('limit') ?? '50');
      return (this.byChannel.get(history[1]!) ?? [])
        .filter((message) => BigInt(message.id) < before)
        .slice(0, limit)
        .map((message) => rawMessage(message));
    }
    const channel = CHANNEL_ROUTE.exec(route);
    if (channel !== null) {
      const known = this.channels.get(channel[1]!);
      return { id: channel[1], type: ChannelType.GuildVoice, name: known?.name, guild_id: '1' };
    }
    throw new Error('Unsupported synthetic REST route');
  }
}

/** A guild of voice channels (no thread discovery) the archive can read completely. */
export const fakeClient = (
  channels: ReadonlyMap<string, FakeChannel>,
  rest: FakeDiscordRest,
): { client: Client; guild: Guild } => {
  const everyone = {};
  const guild = {
    id: '1',
    members: { me: {} },
    roles: { everyone },
  } as unknown as Guild;
  const permissions = { has: () => true };
  const cache = new Map<string, GuildBasedChannel>();
  for (const channel of channels.values())
    cache.set(channel.id, {
      id: channel.id,
      name: channel.name,
      type: ChannelType.GuildVoice,
      parentId: null,
      parent: null,
      guild,
      messages: {},
      permissionsFor: () => permissions,
      isThread: () => false,
      isDMBased: () => false,
      isTextBased: () => true,
    } as unknown as GuildBasedChannel);
  const client = {
    user: { id: '400000000000000001' },
    rest: { get: rest.get, patch: rest.patch },
    channels: { cache, fetch: async (id: string) => cache.get(id) ?? null },
    guilds: { fetch: async () => guild },
  } as unknown as Client;
  Object.assign(guild, {
    client,
    channels: {
      cache,
      fetch: async () => cache,
      fetchActiveThreads: async () => ({ threads: new Map() }),
    },
  });
  return { client, guild };
};
