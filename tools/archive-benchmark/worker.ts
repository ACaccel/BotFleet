import {
  buildArchiveRepos,
  buildArchiveWriterRepos,
} from '../../src/persistence/repositories/archive-repos';
import { archiveBackupNotifiers } from '../../src/plugins/message-backup/runtime/backup-notifier';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createConnection, type Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ArchivePolicySchema } from '../../src/core/archive/policy';
import { reactionKey, reactionStreamKey } from '../../src/core/archive/normalize';
import type {
  ArchiveFullBackupJob,
  ArchiveMessage,
  ArchivePeriodicRun,
} from '../../src/core/archive/types';
import { createLogger } from '../../src/core/logger';
import type { Translator } from '../../src/core/i18n';
import { archiveControlFactory } from '../../src/application/archive/control';
import { StaticConnectionManager } from '../../src/infra/mongo/connection-manager';
import { archiveRuntimeSchema } from '../../src/plugins/message-backup/config';
import { ArchiveGatewayDecoder } from '../../src/plugins/message-backup/runtime/gateway-event';
import { ArchiveWorker } from '../../src/plugins/message-backup/runtime/worker';
import { ArchiveScheduler } from '../../src/plugins/message-backup/flow/scheduler';
import { FullBackupSourceOrder } from '../../src/plugins/message-backup/runtime/source-order';
import type { ArchiveReactionDoc } from '../../src/persistence/schemas/archive.schema';
import {
  FakeDiscordRest,
  fakeClient,
  fakeMessages,
  rawMessage,
  snowflakeAt,
  type FakeChannel,
  type FakeMessage,
} from './discord-fake';
import { DatabaseMetrics, summarize } from './metrics';

/**
 * End-to-end worker probe: the real `ArchiveWorker`, repository and MongoDB 8.2.6
 * against a synthetic guild served by {@link FakeDiscordRest}, which serializes
 * requests per SDK handler like `@discordjs/rest`. Scenarios:
 *
 * - `full`: a confirmed full backup of an empty archive.
 * - `rescan`: a second full backup over the archive the first one stored, which
 *   orders its sources by stored work.
 * - `periodic`: the next periodic pass, whose overlap window revisits every message.
 * - `live`: MESSAGE_CREATE and MESSAGE_REACTION_ADD packets decoded and drained.
 * - `segments`: the largest channel split into adjacent snowflake ranges that share
 *   its SDK handlers (`shared`) or not (`independent`), measuring what segmenting a
 *   channel could gain under the SDK's per-handler serialization.
 */
interface ProbeOptions {
  readonly latencyMs: number;
  readonly largest: number;
  readonly small: number;
  readonly smallChannels: number;
  readonly reactionRate: number;
  readonly concurrency: number;
  readonly runs: number;
  readonly liveCreates: number;
  readonly liveReactions: number;
  readonly segments: readonly number[];
  readonly scenarios: ReadonlySet<string>;
  /** Comparison only: admit one request per channel, whatever its route. */
  readonly channelMutex: boolean;
  /** The large channel is discovered last instead of first. */
  readonly largestLast: boolean;
  /** Comparison only: full backups keep discovery order. */
  readonly discoveryOrder: boolean;
}

/** Restores discovery order for comparison: full backups scan sources as discovered. */
const useDiscoveryOrder = (): void => {
  FullBackupSourceOrder.prototype.order = async (channels) => channels;
};

/**
 * Restores the earlier admission rule for comparison: every request of a channel
 * shares one resource, so history, message and reaction reads exclude each other.
 */
const useChannelMutex = (): void => {
  const run = ArchiveScheduler.prototype.run;
  ArchiveScheduler.prototype.run = function <T>(
    this: ArchiveScheduler,
    key: string,
    priority: Parameters<typeof run>[1],
    operation: () => Promise<T>,
    options: Parameters<typeof run>[3] = {},
  ): Promise<T> {
    const [kind, id, detail] = key.split(':');
    const derived =
      kind === 'history' || kind === 'reaction'
        ? id
        : kind === 'discovery'
          ? id === 'known'
            ? detail
            : id
          : undefined;
    const channelId = options.resource?.channelId ?? derived;
    return run.call(this, key, priority, operation, {
      ...options,
      ...(channelId === undefined ? {} : { resource: { channelId } }),
    }) as Promise<T>;
  };
};

interface Measurement {
  readonly elapsedMs: number;
  readonly rest: Record<string, number>;
  readonly restTotal: number;
  readonly db: Readonly<Record<string, { readonly count: number }>>;
  readonly dbCommands: number;
}

const logger = createLogger({ level: 'silent', pretty: false });
const translator = {
  t: (key: string) => key,
} as unknown as Translator;
const actor = {
  userId: '500000000000000001',
  channelId: '500000000000000002',
  messageId: '500000000000000003',
};

const channelId = (index: number): string => `1${String(index + 1).padStart(17, '0')}`;

interface Dataset {
  readonly channels: Map<string, FakeChannel>;
  readonly messages: FakeMessage[];
}

/**
 * One large channel and several small ones, in discovery (channel ID) order; the
 * large one is first unless `largestLast`. `segments` > 1 splits the large channel
 * into that many channels of adjacent ID ranges; `shared` keeps them on the large
 * channel's SDK handlers.
 */
const dataset = (options: ProbeOptions, endAt: number, segments = 1, shared = true): Dataset => {
  const smalls = Array.from({ length: options.smallChannels }, () => options.small);
  const layout = (
    options.largestLast ? [...smalls, options.largest] : [options.largest, ...smalls]
  ).map((messages, index) => ({ id: channelId(index), messages }));
  const messages = fakeMessages({ channels: layout, reactionRate: options.reactionRate, endAt });
  const channels = new Map<string, FakeChannel>();
  for (const [index, entry] of layout.entries())
    channels.set(entry.id, { id: entry.id, name: `voice-${index}`, bucketId: entry.id });
  if (segments <= 1) return { channels, messages };
  const largest = layout[options.largestLast ? layout.length - 1 : 0]!.id;
  const ids = Array.from(
    { length: segments },
    (_, index) => `8${String(index + 1).padStart(17, '0')}`,
  );
  channels.delete(largest);
  for (const [index, id] of ids.entries())
    channels.set(id, { id, name: `segment-${index}`, bucketId: shared ? largest : id });
  const own = messages.filter((message) => message.channelId === largest);
  const span = Math.ceil(own.length / segments);
  const reassigned = new Map(
    own.map((message, index) => [
      message.id,
      ids[Math.min(segments - 1, Math.floor(index / span))]!,
    ]),
  );
  return {
    channels,
    messages: messages.map((message) => {
      const segment = reassigned.get(message.id);
      return segment === undefined ? message : { ...message, channelId: segment };
    }),
  };
};

const cloneMessages = (messages: readonly FakeMessage[]): FakeMessage[] =>
  messages.map((message) => ({
    ...message,
    reactions: message.reactions.map((reaction) => ({
      ...reaction,
      normal: [...reaction.normal],
      burst: [...reaction.burst],
    })),
  }));

class Harness {
  public readonly rest: FakeDiscordRest;
  public readonly worker: ArchiveWorker;
  private readonly decoder = new ArchiveGatewayDecoder('benchmark');
  private sequence = 0;

  public constructor(
    private readonly connection: Connection,
    data: Dataset,
    options: ProbeOptions,
  ) {
    this.rest = new FakeDiscordRest(data.channels, cloneMessages(data.messages), options.latencyMs);
    const { client } = fakeClient(data.channels, this.rest);
    this.worker = new ArchiveWorker({
      client,
      connections: new StaticConnectionManager(connection),
      registry: {
        getRepos: () => undefined,
        getChannel: () => undefined,
        getRole: () => undefined,
        listGuildIds: () => ['1'],
      } as never,
      config: archiveRuntimeSchema.parse({
        concurrency: options.concurrency,
        overlap_minutes: 1440,
      }),
      policy: ArchivePolicySchema.parse({ guildIds: ['1'] }),
      guildIds: ['1'],
      logger,
      translator,
      backupNotifiers: archiveBackupNotifiers(client, translator),
      archiveRepos: buildArchiveRepos,
      writerRepos: buildArchiveWriterRepos,
    });
  }

  public async measure(work: () => Promise<void>): Promise<Measurement> {
    const before = { ...this.rest.requests };
    const stop = new DatabaseMetrics().attach(this.connection.getClient());
    const started = performance.now();
    await work();
    const elapsedMs = performance.now() - started;
    const db = stop();
    const rest = Object.fromEntries(
      Object.entries(this.rest.requests).map(([key, value]) => [
        key,
        value - before[key as keyof typeof before],
      ]),
    );
    return {
      elapsedMs,
      rest,
      restTotal: Object.values(rest).reduce((sum, value) => sum + value, 0),
      db,
      dbCommands: Object.values(db).reduce((sum, metric) => sum + metric.count, 0),
    };
  }

  public async fullBackup(): Promise<void> {
    const control = archiveControlFactory(buildArchiveRepos)({
      guild: (await this.worker.initialize('1')).conn,
      defaultIntervalMs: 60_000,
    });
    const { token } = await control.requestConfirmation(actor);
    const confirmed = await control.confirm(token, actor);
    if (!confirmed.ok) throw confirmed.error;
    const job = confirmed.value;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await this.worker.pollJobs('1');
      const saved = await this.connection
        .collection<ArchiveFullBackupJob>('archive_jobs')
        .findOne({ jobId: job.jobId });
      if (saved?.status === 'complete') return;
      if (saved?.status !== 'queued' && saved?.status !== 'running')
        throw new Error(`Full backup ended ${saved?.status ?? 'missing'}`);
    }
    throw new Error('Full backup did not finish');
  }

  public async periodic(): Promise<void> {
    await this.worker.periodic('1');
    const run = await this.connection
      .collection<ArchivePeriodicRun>('archive_periodic_runs')
      .findOne({ _id: 'current' });
    if (run?.status !== 'complete') throw new Error(`Periodic pass ended ${run?.status}`);
  }

  /** Captures decoded Gateway packets as the plugin does. */
  public async packet(type: string, data: Record<string, unknown>): Promise<void> {
    this.sequence += 1;
    const events = this.decoder.decode({ t: type, s: this.sequence, d: data }, 0, Date.now());
    for (const event of events) await this.worker.capture(event);
  }

  public async drain(): Promise<void> {
    const inbox = this.connection.collection('archive_inbox');
    for (let round = 0; round < 1000; round += 1) {
      if ((await inbox.countDocuments({ state: { $in: ['pending', 'processing'] } })) === 0) return;
      await this.worker.drainInbox('1');
    }
    throw new Error('Inbox did not drain');
  }

  /** Every stored list of the given messages matches the synthetic source. */
  public async verifyReactions(ids: readonly string[]): Promise<void> {
    const messages = this.connection.collection<ArchiveMessage>('messages');
    const chunks = this.connection.collection<ArchiveReactionDoc>('archive_reactions');
    for (const id of ids) {
      const source = this.rest.message(id);
      const stored = await messages.findOne({ _id: id });
      if (source === undefined || stored === null) throw new Error(`Message ${id} missing`);
      for (const reaction of source.reactions) {
        const key = reactionKey(reaction.emoji)!;
        for (const [type, users] of [
          [0, reaction.normal],
          [1, reaction.burst],
        ] as const) {
          const generation = stored.reactionGenerations?.[reactionStreamKey(key, type)];
          if (generation?.complete !== true)
            throw new Error(`Reaction list ${id} ${key} unpublished`);
          const saved = (
            await chunks
              .find({ messageId: id, emojiKey: key, type, generation: generation.generation })
              .toArray()
          ).flatMap((chunk) => chunk.userIds);
          if (saved.length !== users.length || users.some((user) => !saved.includes(user)))
            throw new Error(`Reaction list ${id} ${key} differs from the source`);
        }
      }
    }
  }

  public async stop(): Promise<void> {
    await this.worker.stop();
  }
}

const sampleOf = <T>(values: readonly T[], count: number): T[] => {
  const step = Math.max(1, Math.floor(values.length / count));
  return values.filter((_, index) => index % step === 0).slice(0, count);
};

async function main(output: string, options: ProbeOptions): Promise<void> {
  // The storage monitor walks the working directory; an empty one keeps that walk
  // out of the measurement (tools/archive-benchmark/storage.ts measures it).
  const server = await MongoMemoryServer.create({
    binary: { version: '8.2.6' },
    instance: { ip: '127.0.0.1', args: ['--wiredTigerCacheSizeGB', '0.25'] },
  });
  const workspace = await mkdtemp(join(tmpdir(), 'archive-worker-probe-'));
  const home = process.cwd();
  process.chdir(workspace);
  const report: Record<string, unknown> = {
    version: 1,
    node: process.version,
    mongo: '8.2.6',
    writeConcern: { w: 'majority', j: true },
    options: { ...options, scenarios: [...options.scenarios] },
  };
  try {
    let database = 0;
    const open = async (): Promise<Connection> => {
      database += 1;
      const connection = createConnection(server.getUri(`archive_worker_probe_${database}`), {
        writeConcern: { w: 'majority', j: true },
        maxPoolSize: 4,
        monitorCommands: true,
      });
      await connection.asPromise();
      return connection;
    };
    const lifecycle: Record<string, Measurement[]> = {
      full: [],
      periodic: [],
      live: [],
      rescan: [],
    };
    if (['full', 'periodic', 'live'].some((name) => options.scenarios.has(name))) {
      for (let run = 0; run < options.runs; run += 1) {
        const connection = await open();
        const data = dataset(options, Date.now() - 60_000);
        const harness = new Harness(connection, data, options);
        try {
          await harness.worker.initialize('1');
          lifecycle['full']!.push(await harness.measure(() => harness.fullBackup()));
          const reacted = data.messages.filter((message) => message.reactions.length > 0);
          await harness.verifyReactions(sampleOf(reacted, 60).map((message) => message.id));
          if (options.scenarios.has('periodic') || options.scenarios.has('live'))
            lifecycle['periodic']!.push(await harness.measure(() => harness.periodic()));
          if (options.scenarios.has('live')) {
            const targets = sampleOf(
              reacted.filter((message) => message.reactions.length >= 2),
              options.liveReactions,
            );
            const created: FakeMessage[] = Array.from(
              { length: options.liveCreates },
              (_, index) => ({
                id: snowflakeAt(Date.now(), 4000 + index),
                channelId: channelId(1),
                createdAt: Date.now(),
                reactions: [],
              }),
            );
            lifecycle['live']!.push(
              await harness.measure(async () => {
                for (const message of created) {
                  harness.rest.add(message);
                  await harness.packet('MESSAGE_CREATE', rawMessage(message, true));
                }
                for (const target of targets) {
                  const source = harness.rest.message(target.id)!;
                  const reaction = source.reactions[0]!;
                  const user = `6${String(reaction.normal.length).padStart(17, '0')}`;
                  reaction.normal.push(user);
                  await harness.packet('MESSAGE_REACTION_ADD', {
                    user_id: user,
                    channel_id: target.channelId,
                    message_id: target.id,
                    guild_id: '1',
                    emoji: reaction.emoji,
                    burst: false,
                    type: 0,
                  });
                }
                await harness.drain();
              }),
            );
            await harness.verifyReactions(targets.map((target) => target.id));
            const stored = await connection
              .collection<{ _id: string }>('messages')
              .countDocuments({ _id: { $in: created.map((message) => message.id) } });
            if (stored !== created.length) throw new Error('Live messages missing');
          }
        } finally {
          await harness.stop();
          await connection.dropDatabase();
          await connection.close();
        }
      }
    }
    if (options.scenarios.has('rescan'))
      for (let run = 0; run < options.runs; run += 1) {
        const connection = await open();
        const data = dataset(options, Date.now() - 60_000);
        const harness = new Harness(connection, data, options);
        try {
          await harness.worker.initialize('1');
          await harness.fullBackup();
          lifecycle['rescan']!.push(await harness.measure(() => harness.fullBackup()));
          const reacted = data.messages.filter((message) => message.reactions.length > 0);
          await harness.verifyReactions(sampleOf(reacted, 60).map((message) => message.id));
        } finally {
          await harness.stop();
          await connection.dropDatabase();
          await connection.close();
        }
      }
    const summary = (samples: readonly Measurement[]) =>
      samples.length < 3
        ? undefined
        : {
            elapsedMs: summarize(samples.map((sample) => sample.elapsedMs)),
            restTotal: summarize(samples.map((sample) => sample.restTotal)),
            dbCommands: summarize(samples.map((sample) => sample.dbCommands)),
            rest: samples[0]!.rest,
            db: Object.fromEntries(
              Object.entries(samples[0]!.db).map(([key, value]) => [key, value.count]),
            ),
          };
    for (const [name, samples] of Object.entries(lifecycle))
      if (options.scenarios.has(name)) report[name] = { samples, summary: summary(samples) };
    if (options.scenarios.has('segments')) {
      const variants = [];
      for (const segments of options.segments)
        for (const shared of segments === 1 ? [true] : [true, false]) {
          const samples: Measurement[] = [];
          for (let run = 0; run < options.runs; run += 1) {
            const connection = await open();
            const harness = new Harness(
              connection,
              dataset(options, Date.now() - 60_000, segments, shared),
              options,
            );
            try {
              await harness.worker.initialize('1');
              samples.push(await harness.measure(() => harness.fullBackup()));
            } finally {
              await harness.stop();
              await connection.dropDatabase();
              await connection.close();
            }
          }
          variants.push({ segments, shared, samples, summary: summary(samples) });
        }
      report['segments'] = variants;
    }
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    for (const [name, value] of Object.entries(report))
      if (typeof value === 'object' && value !== null && 'summary' in value)
        process.stdout.write(
          `${name} ${JSON.stringify((value as { summary: unknown }).summary)}\n`,
        );
    if (Array.isArray(report['segments']))
      for (const variant of report['segments'] as {
        segments: number;
        shared: boolean;
        summary: unknown;
      }[])
        process.stdout.write(
          `segments=${variant.segments} shared=${variant.shared} ${JSON.stringify(variant.summary)}\n`,
        );
  } finally {
    await server.stop({ doCleanup: true, force: true });
    process.chdir(home);
    await rm(workspace, { recursive: true, force: true });
  }
}

const flag = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
};

if (require.main === module) {
  const output = process.argv[2];
  if (output === undefined || output.startsWith('--'))
    throw new Error('Provide a new output report path');
  const options: ProbeOptions = {
    latencyMs: Number(flag('latency', '10')),
    largest: Number(flag('largest', '2000')),
    small: Number(flag('small', '300')),
    smallChannels: Number(flag('small-channels', '3')),
    reactionRate: Number(flag('reaction-rate', '0.1')),
    concurrency: Number(flag('concurrency', '2')),
    runs: Number(flag('runs', '3')),
    liveCreates: Number(flag('live-creates', '100')),
    liveReactions: Number(flag('live-reactions', '50')),
    segments: flag('segments', '1,2,4').split(',').map(Number),
    scenarios: new Set(flag('scenario', 'full,periodic,live').split(',')),
    channelMutex: process.argv.includes('--channel-mutex'),
    largestLast: process.argv.includes('--largest-last'),
    discoveryOrder: process.argv.includes('--discovery-order'),
  };
  if (options.channelMutex) useChannelMutex();
  if (options.discoveryOrder) useDiscoveryOrder();
  void main(resolve(output), options).catch((error: unknown) => {
    process.stderr.write(`Worker benchmark failed: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
