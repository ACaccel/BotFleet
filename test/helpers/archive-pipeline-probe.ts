import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import { ChannelType, type Client, type Guild, type GuildBasedChannel } from 'discord.js';

import type { Logger } from '../../src/core/logger';
import { ArchivePipelineBudget } from '../../src/plugins/message-backup/flow/pipeline';
import { ArchiveScheduler } from '../../src/plugins/message-backup/flow/scheduler';
import {
  scanArchiveHistory,
  type HistoryCheckpoint,
} from '../../src/plugins/message-backup/runtime/history';

interface ProbeOptions {
  concurrency: number;
  prefetch: boolean;
  channels?: number;
  pages?: number;
  requestLatencyMs?: number;
  writeLatencyMs?: number;
  quotaIntervalMs?: number;
}

/** Actual history/scheduler code with one simulated REST manager and durable storage latency. */
export async function runArchivePipelineProbe(options: ProbeOptions) {
  const scheduler = new ArchiveScheduler({ concurrency: options.concurrency });
  const pipeline = new ArchivePipelineBudget();
  const checkpoints = new Map<string, HistoryCheckpoint>();
  const committed: string[] = [];
  const sources = new Map<string, Record<string, unknown>[]>();
  const channels = new Map<string, GuildBasedChannel>();
  let successfulRequests = 0;
  let restActive = 0;
  let peakRestActive = 0;
  let nextQuotaAt = 0;
  const quota = options.quotaIntervalMs ?? 0;
  const requestLatency = options.requestLatencyMs ?? 5;
  const writeLatency = options.writeLatencyMs ?? 5;
  const guild = { id: '123', members: { me: {} } } as unknown as Guild;
  for (let channel = 0; channel < (options.channels ?? 8); channel += 1) {
    const id = String(1000 + channel);
    channels.set(id, {
      id,
      name: `synthetic-${channel}`,
      parentId: null,
      type: ChannelType.GuildVoice,
      guild,
      permissionsFor: () => ({ has: () => true }),
      messages: {},
    } as unknown as GuildBasedChannel);
    sources.set(
      id,
      Array.from({ length: (options.pages ?? 3) * 100 }, (_, index) => ({
        id: String(1_000_000 + channel * 10_000 - index),
        content: 'Synthetic probe message',
      })),
    );
  }
  const inventory = (): { id: string; type: number; name: string }[] =>
    [...channels].map(([id, channel]) => ({ id, type: channel.type, name: channel.name }));
  const get = async (
    route: string,
    request?: { query?: URLSearchParams; signal?: AbortSignal },
  ): Promise<unknown> => {
    const wait = Math.max(0, nextQuotaAt - Date.now());
    if (quota > 0) {
      nextQuotaAt = Math.max(Date.now(), nextQuotaAt) + quota;
      if (wait > 0)
        scheduler.observeWait({
          resourceId: 'global',
          bucketKey: 'synthetic-global',
          global: true,
          deadlineAt: Date.now() + wait,
        });
    }
    if (wait > 0) await delay(wait, undefined, { signal: request?.signal });
    restActive += 1;
    peakRestActive = Math.max(peakRestActive, restActive);
    try {
      await delay(requestLatency, undefined, { signal: request?.signal });
      successfulRequests += 1;
      if (route === '/guilds/123/channels') return inventory();
      if (route === '/guilds/123/threads/active') return { threads: [] };
      const channelId = route.split('/')[2];
      const messages = sources.get(channelId ?? '');
      if (messages === undefined) throw new Error('Unsupported synthetic REST route');
      const before = BigInt(request?.query?.get('before') ?? '0');
      return messages.filter((message) => BigInt(message.id as string) < before).slice(0, 100);
    } finally {
      restActive -= 1;
    }
  };
  const client = {
    rest: { get },
    channels: { fetch: async (id: string) => channels.get(id) ?? null },
  } as unknown as Client;
  Object.assign(guild, {
    client,
    channels: {
      cache: channels,
      fetch: async () => {
        await get('/guilds/123/channels');
        return channels;
      },
      fetchActiveThreads: async () => {
        await get('/guilds/123/threads/active');
        return { threads: new Map() };
      },
    },
  });
  const started = performance.now();
  try {
    const result = await scanArchiveHistory(guild, client, {} as Logger, {
      runId: 'synthetic-run',
      cutoff: 1_800_000_000_000,
      full: true,
      overlapMinutes: 60,
      concurrency: options.concurrency,
      signal: new AbortController().signal,
      pipelineBudget: pipeline,
      prefetch: options.prefetch,
      load: async (channelId) => ({ checkpoint: checkpoints.get(channelId) }),
      checkpoint: async (channel, checkpoint) => {
        checkpoints.set(channel.id, structuredClone(checkpoint));
      },
      consume: async () => {
        throw new Error('Probe requires the page consumer');
      },
      consumePage: async (messages) => {
        const writeStarted = Date.now();
        await delay(writeLatency);
        committed.push(...messages.map((message) => message.id as string));
        pipeline.record('write', Date.now() - writeStarted);
        return messages.map(() => true);
      },
      afterPage: async () => undefined,
      request: (key, operation, signal) =>
        scheduler.run(key, 'history', operation, { signal, guildId: guild.id }),
      progress: async () => undefined,
    });
    const elapsedMs = performance.now() - started;
    const equivalenceDigest = createHash('sha256')
      .update(JSON.stringify([...committed].sort()))
      .digest('hex');
    return {
      version: 1,
      scope: 'synthetic-shared-rest-and-storage-latency',
      elapsedMs,
      messagesConfirmed: result.scanned,
      successfulRequests,
      actual429: 0,
      messagesPerSecond: result.scanned / (elapsedMs / 1000),
      requestsPerSecond: successfulRequests / (elapsedMs / 1000),
      peakRestActive,
      issues: result.issues,
      completedSources: result.channels,
      equivalenceDigest,
      scheduler: scheduler.snapshot(),
      pipeline: pipeline.snapshot(),
      assumptions: {
        requestLatencyMs: requestLatency,
        writeLatencyMs: writeLatency,
        quotaIntervalMs: quota,
        osCold: false,
      },
    };
  } finally {
    scheduler.stop();
  }
}
