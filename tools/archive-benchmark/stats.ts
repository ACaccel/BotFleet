import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createConnection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { ArchiveChannelInfo, StatsWindow } from '../../src/core/archive/stats';
import type { ArchiveMessage } from '../../src/core/archive/types';
import { asGuildId } from '../../src/core/ids';
import { StaticConnectionManager } from '../../src/infra/mongo/connection-manager';
import { snowflakeAt } from '../../src/persistence/repositories/archive-stats.pipelines';
import { MongoArchiveStatsRepo } from '../../src/persistence/repositories/archive-stats.repo';
import type { ArchiveReactionDoc } from '../../src/persistence/schemas/archive.schema';
import { summarize } from './metrics';

const DAY_MS = 86_400_000;
/** Dataset end; windows end here. */
const END_MS = Date.UTC(2026, 9, 1);
const TEXT_CHANNELS = 80;
const THREADS = 900;
const FORUM_POSTS = 120;
const AUTHORS = 3_000;
const EMOJI = 60;
const STICKERS = 20;
const APPS = 6;
const BATCH = 10_000;

export interface StatsDatasetOptions {
  readonly messages: number;
  readonly days: number;
  readonly seed?: number;
}

/** Deterministic PRNG so every run measures the same synthetic documents. */
const random = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/** Channel layout: text channels, threads under them, and forum posts under two forums. */
export const statsChannels = (): ArchiveChannelInfo[] => [
  ...Array.from({ length: TEXT_CHANNELS }, (_, index) => ({
    channelId: `1${String(index).padStart(17, '0')}`,
    name: `text-${index}`,
    type: 0,
    access: 'readable' as const,
    everyoneCanView: index % 4 !== 0,
  })),
  { channelId: '200000000000000000', name: 'forum-a', type: 15, access: 'readable' },
  { channelId: '200000000000000001', name: 'forum-b', type: 15, access: 'readable' },
  ...Array.from({ length: THREADS }, (_, index) => ({
    channelId: `3${String(index).padStart(17, '0')}`,
    name: `thread-${index}`,
    type: 11,
    parentId: `1${String(index % TEXT_CHANNELS).padStart(17, '0')}`,
    access: 'readable' as const,
  })),
  ...Array.from({ length: FORUM_POSTS }, (_, index) => ({
    channelId: `4${String(index).padStart(17, '0')}`,
    name: `post-${index}`,
    type: 11,
    parentId: `20000000000000000${index % 2}`,
    access: 'readable' as const,
  })),
];

/**
 * Synthetic messages spread evenly over `days` before {@link END_MS}, with a skewed
 * author and channel mix, replies, mentions, attachments, reactions, custom emoji,
 * stickers, bots and interaction records in fixed proportions.
 */
export function* statsMessages(options: StatsDatasetOptions): Generator<ArchiveMessage> {
  const next = random(options.seed ?? 1);
  const channels = statsChannels().filter((channel) => channel.type !== 15);
  const span = options.days * DAY_MS;
  const start = END_MS - span;
  const skewed = (size: number): number => Math.floor(size * next() ** 3);
  for (let index = 0; index < options.messages; index += 1) {
    const at = start + Math.floor((index / options.messages) * span);
    const authorId = `9${String(skewed(AUTHORS)).padStart(17, '0')}`;
    const channelId = channels[skewed(channels.length)]!.channelId;
    const roll = next();
    const base: ArchiveMessage = {
      _id: (snowflakeAt(at) + BigInt(index % 4_000_000)).toString(),
      schemaVersion: 3,
      channelId,
      createdTimestamp: at,
      observedAt: at,
      author: { id: authorId, username: `user${authorId.slice(-4)}`, globalName: null },
      type: 0,
      flags: 0,
      content: `synthetic message ${index} with a few ordinary words in it`,
      editedTimestamp: roll < 0.05 ? at + 60_000 : null,
      attachments: roll > 0.95 ? [{ contentType: 'image/png', name: 'a.png', size: 1000 }] : [],
      stickers: roll > 0.99 ? [{ id: `7${String(skewed(STICKERS)).padStart(17, '0')}` }] : [],
      embeds: [],
      reactions:
        next() < 0.12
          ? [
              { emoji: { name: '👍' }, count: 1 + skewed(8) },
              ...(next() < 0.4
                ? [
                    {
                      emoji: { id: `6${String(skewed(EMOJI)).padStart(17, '0')}`, name: 'e' },
                      count: 2,
                    },
                  ]
                : []),
            ]
          : [],
      mentions: {
        users: next() < 0.1 ? [`9${String(skewed(AUTHORS)).padStart(17, '0')}`] : [],
        roles: [],
        channels: [],
        everyone: false,
      },
    };
    if (roll < 0.15) {
      const replied = `9${String(skewed(AUTHORS)).padStart(17, '0')}`;
      yield { ...base, type: 19, reference: { type: 0, authorId: replied, messageId: '1' } };
    } else if (roll < 0.17) {
      yield { ...base, author: { id: '8100', username: 'bot', bot: true } };
    } else if (roll < 0.18) {
      const app = String(skewed(APPS));
      yield {
        _id: base._id,
        schemaVersion: 3,
        channelId,
        createdTimestamp: at,
        observedAt: at,
        author: { id: `82${app}`, username: `app${app}`, bot: true },
        applicationId: `82${app}`,
        type: 20,
        interactionMetadata: {
          id: `i${index}`,
          type: next() < 0.8 ? 2 : 3,
          user: { id: authorId },
        },
      };
    } else if (roll < 0.2) {
      yield {
        ...base,
        content: `look <:e:6${String(skewed(EMOJI)).padStart(17, '0')}> https://example.com`,
      };
    } else {
      yield base;
    }
  }
}

const reactionChunk = (message: ArchiveMessage, userIds: string[]): ArchiveReactionDoc => ({
  messageId: message._id,
  channelId: message.channelId,
  emojiKey: '👍',
  type: 0,
  generation: 'g1',
  chunk: 0,
  userIds,
  observedAt: message.createdTimestamp,
});

interface Measured {
  readonly name: string;
  readonly window: string;
  readonly elapsedMs: ReturnType<typeof summarize>;
}

async function main(output: string, options: StatsDatasetOptions, cacheGb: number): Promise<void> {
  const server = await MongoMemoryServer.create({
    binary: { version: '8.2.6' },
    instance: { ip: '127.0.0.1', args: ['--wiredTigerCacheSizeGB', String(cacheGb)] },
  });
  const connection = createConnection(server.getUri('archive_stats_benchmark'), { maxPoolSize: 4 });
  try {
    await connection.asPromise();
    const guild = await new StaticConnectionManager(connection).getConnection(asGuildId('1'));
    const channels = statsChannels();
    await connection.collection('archive_channels').insertMany(channels.map((c) => ({ ...c })));
    const loadStarted = performance.now();
    let batch: ArchiveMessage[] = [];
    let reactions: ArchiveReactionDoc[] = [];
    const heavyUser = `9${'0'.repeat(17)}`;
    const flush = async (): Promise<void> => {
      if (batch.length > 0)
        await connection
          .collection<ArchiveMessage>('messages')
          .insertMany(batch, { ordered: false });
      if (reactions.length > 0)
        await connection
          .collection<ArchiveReactionDoc>('archive_reactions')
          .insertMany(reactions, { ordered: false });
      batch = [];
      reactions = [];
    };
    for (const message of statsMessages(options)) {
      if (message.reactions?.length) {
        batch.push({
          ...message,
          reactionGenerations: { '👍:0': { generation: 'g1', observedAt: 0, complete: true } },
        });
        reactions.push(reactionChunk(message, [heavyUser, `9${message._id.slice(-17)}`]));
      } else batch.push(message);
      if (batch.length >= BATCH) await flush();
    }
    await flush();
    const loadMs = performance.now() - loadStarted;
    const stats = await connection.db!.command({ collStats: 'messages' });

    const repo = new MongoArchiveStatsRepo(guild, { maxTimeMs: 600_000 });
    const channelIds = channels.map((channel) => channel.channelId);
    const scope = { channelIds };
    const emojiIds = Array.from({ length: EMOJI }, (_, i) => `6${String(i).padStart(17, '0')}`);
    const stickerIds = Array.from(
      { length: STICKERS },
      (_, i) => `7${String(i).padStart(17, '0')}`,
    );
    const measured: Measured[] = [];
    const time = async (name: string, label: string, run: () => Promise<unknown>) => {
      const samples: number[] = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const started = performance.now();
        const result = (await run()) as { ok: boolean };
        if (!result.ok) throw new Error(`${name} ${label} failed`);
        if (attempt > 0) samples.push(performance.now() - started);
      }
      measured.push({ name, window: label, elapsedMs: summarize(samples) });
    };
    for (const days of [7, 30, 365]) {
      const label = `${days}d`;
      const window: StatsWindow = { startMs: END_MS - days * DAY_MS, endMs: END_MS };
      const previousWindow: StatsWindow = {
        startMs: window.startMs - days * DAY_MS,
        endMs: window.startMs,
      };
      const granularity = days === 365 ? 'week' : 'day';
      await time('overview', label, () =>
        repo.activity({
          window,
          previousWindow,
          scope,
          timeZone: 'Asia/Taipei',
          sections: {
            summary: {},
            trend: { granularity },
            heatmap: {},
            channels: {},
            authors: {},
            reactions: {},
            retention: {},
            topMessages: { limit: 3 },
          },
        }),
      );
      await time('member', label, () =>
        repo.activity({
          window,
          previousWindow,
          scope,
          timeZone: 'Asia/Taipei',
          sections: {
            summary: { authorId: heavyUser },
            trend: { granularity, authorId: heavyUser },
            heatmap: { authorId: heavyUser },
            channels: { authorId: heavyUser },
            authors: { rankOf: heavyUser },
            reactions: { authorId: heavyUser },
            activeDays: { userId: heavyUser },
            partners: { userId: heavyUser },
          },
        }),
      );
      await time('reactionsGiven', label, () => repo.reactionsGiven(window, heavyUser, scope));
      await time('appUsage', label, () =>
        repo.appUsage(window, scope, { trend: { granularity, timeZone: 'Asia/Taipei' } }),
      );
      await time('emojiUsage', label, () => repo.emojiUsage(window, emojiIds));
      await time('stickerUsage', label, () => repo.stickerUsage(window, stickerIds));
    }
    await writeFile(
      output,
      JSON.stringify(
        {
          version: 1,
          node: process.version,
          mongo: '8.2.6',
          wiredTigerCacheSizeGB: cacheGb,
          dataset: {
            ...options,
            channels: channels.length,
            authors: AUTHORS,
            storageBytes: stats.storageSize,
            dataBytes: stats.size,
            averageDocumentBytes: stats.avgObjSize,
            loadMs,
          },
          visibleChannelIds: channelIds.length,
          samplesPerQuery: 3,
          measured,
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
  } finally {
    try {
      await connection.close();
    } finally {
      await server.stop({ doCleanup: true, force: true });
    }
  }
}

const numberArgument = (name: string, fallback: number): number => {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
};

if (require.main === module) {
  const output = process.argv[2];
  if (output === undefined || output.startsWith('--'))
    throw new Error('Provide a new output report path');
  const options = {
    messages: numberArgument('--messages', 1_000_000),
    days: numberArgument('--days', 400),
  };
  void main(output, options, numberArgument('--cache-gb', 1)).catch((error: unknown) => {
    process.stderr.write(
      `Stats benchmark failed: ${error instanceof Error ? error.message : 'unknown'}\n`,
    );
    process.exitCode = 1;
  });
}
