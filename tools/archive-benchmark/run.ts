import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm, statfs, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { MongoMemoryServer } from 'mongodb-memory-server';
import { createConnection, mongo } from 'mongoose';
import type { Connection } from 'mongoose';
import type { RepairDependencies } from '../../src/plugins/message-backup/repair/contracts';

import { ArchivePerformanceSampler } from '../../src/core/archive/performance';
import {
  ArchiveRepairService,
  REPAIR_OPERATIONS,
  REPAIR_RUNS,
} from '../../src/plugins/message-backup/repair/service';
import {
  DATASET_VERSION,
  SCENARIOS,
  datasetIdentity,
  syntheticBatches,
  syntheticMessage,
} from './dataset';
import type { Scenario, SyntheticDocument } from './dataset';
import { DatabaseMetrics, summarize } from './metrics';
import { LiveUpdateProbe } from './live-updates';
import { MongoProcessSampler } from './mongo-process';

interface BenchmarkOptions {
  readonly count: number;
  readonly scenario: Scenario;
  readonly runs: number;
  readonly cache: 'after-seed' | 'warm' | 'mongo-cold';
  readonly output: string;
  readonly maxDatabaseBytes: number;
  readonly batchDocuments: number;
}

export function parseOptions(args: readonly string[]): BenchmarkOptions {
  const values = new Map<string, string>();
  const allowed = ['count', 'scenario', 'runs', 'cache', 'output', 'max-db-mib', 'batch-documents'];
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/, '');
    const value = args[index + 1];
    if (
      key === undefined ||
      !args[index]?.startsWith('--') ||
      !allowed.includes(key) ||
      value === undefined ||
      values.has(key)
    )
      throw new Error(
        'Expected unique --count, --scenario, --runs, --cache, --output, --max-db-mib or --batch-documents options',
      );
    values.set(key, value);
  }
  const count = Number(values.get('count') ?? 100_000);
  const runs = Number(values.get('runs') ?? 3);
  const maxDatabaseMiB = Number(values.get('max-db-mib') ?? 1024);
  const batchDocuments = Number(values.get('batch-documents') ?? 500);
  const scenario = values.get('scenario') ?? 'clean';
  const cache = values.get('cache') ?? 'after-seed';
  const output = values.get('output');
  if (!Number.isSafeInteger(count) || count < 1 || count > 5_500_000)
    throw new Error('Count must be between 1 and 5500000');
  if (!Number.isSafeInteger(runs) || runs < 3 || runs > 10)
    throw new Error('Runs must be between 3 and 10');
  if (!Number.isSafeInteger(maxDatabaseMiB) || maxDatabaseMiB < 16 || maxDatabaseMiB > 81920)
    throw new Error('Database budget must be between 16 and 81920 MiB');
  if (!Number.isSafeInteger(batchDocuments) || batchDocuments < 1 || batchDocuments > 1000)
    throw new Error('Batch documents must be between 1 and 1000');
  if (!SCENARIOS.includes(scenario as Scenario)) throw new Error('Unknown synthetic scenario');
  if (cache !== 'after-seed' && cache !== 'warm' && cache !== 'mongo-cold')
    throw new Error('Cache must be after-seed, warm or mongo-cold');
  if (output === undefined || output.length === 0) throw new Error('--output is required');
  return {
    count,
    runs,
    scenario: scenario as Scenario,
    cache,
    output: resolve(output),
    maxDatabaseBytes: maxDatabaseMiB * 1024 * 1024,
    batchDocuments,
  };
}

interface Measurement {
  readonly run: number;
  readonly phase: 'audit' | 'plan' | 'verify';
  readonly elapsedMs: number;
  readonly messagesPerSecond: number;
  readonly result: {
    readonly status: string;
    readonly counts: Readonly<Record<string, number>>;
    readonly issueCount: number;
  };
  readonly process: ReturnType<ArchivePerformanceSampler['stop']>;
  readonly db: ReturnType<DatabaseMetrics['snapshot']>;
  readonly liveUpdates: number;
  readonly liveUpdateLatency?: { meanMs: number; maximumMs: number };
  readonly mongoProcess: ReturnType<MongoProcessSampler['stop']>;
}

async function limitFile(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return null;
  }
}

/** The harness creates its own localhost server; no connection URI or operator config is accepted. */
export async function runBenchmark(
  options: BenchmarkOptions,
  implementation?: {
    create(
      connection: Connection,
      dependencies: RepairDependencies,
    ): Pick<ArchiveRepairService, 'execute'>;
    sourceHash: string;
  },
): Promise<Record<string, unknown>> {
  const sourceFiles =
    implementation === undefined
      ? ['service.ts', 'images.ts', 'cancellation.ts', 'planning-journal.ts', 'apply-batch.ts']
      : [];
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (file) => [
        file,
        createHash('sha256')
          .update(
            await readFile(resolve(__dirname, '../../src/plugins/message-backup/repair', file)),
          )
          .digest('hex'),
      ]),
    ),
  );
  const directory = await mkdtemp('/tmp/botfleet-archive-benchmark-');
  const cancellation = new AbortController();
  const cancel = (): void => cancellation.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let server: MongoMemoryServer | undefined;
  let connection: ReturnType<typeof createConnection> | undefined;
  const projectedBytes =
    options.count * mongo.BSON.calculateObjectSize(syntheticMessage(0, options.scenario)) * 6;
  try {
    const filesystem = await statfs(directory);
    const freeBytes = filesystem.bavail * filesystem.bsize;
    if (projectedBytes > options.maxDatabaseBytes || projectedBytes + 512 * 1024 * 1024 > freeBytes)
      throw new Error(
        'Synthetic dataset exceeds database or free-disk budget; choose a smaller count or explicit larger --max-db-mib',
      );
    server = await MongoMemoryServer.create({
      binary: { version: '8.2.6' },
      instance: {
        ip: '127.0.0.1',
        dbPath: directory,
        storageEngine: 'wiredTiger',
        args: ['--wiredTigerCacheSizeGB', '0.25'],
      },
    });
    connection = await createConnection(server.getUri('archive_benchmark'), {
      monitorCommands: true,
      maxPoolSize: 4,
      writeConcern: { w: 'majority', j: true },
    }).asPromise();
    let db = connection.db;
    if (db === undefined) throw new Error('Disposable benchmark database did not open');
    const measurements: Measurement[] = [];
    let seedBytes = 0;
    let maxSeedBatchBytes = 0;
    let reservedJournalBytes = 0;
    const startedAt = new Date().toISOString();
    const seedStart = performance.now();
    for (const batch of syntheticBatches(options)) {
      cancellation.signal.throwIfAborted();
      await db.collection<SyntheticDocument>('messages').insertMany(batch.documents);
      seedBytes += batch.bytes;
      maxSeedBatchBytes = Math.max(maxSeedBatchBytes, batch.bytes);
    }
    await db
      .collection<SyntheticDocument>('fetches')
      .insertOne({ _id: 'synthetic-fetch', channelID: '2000000000000000000', lastMessageID: '' });
    await db
      .collection<SyntheticDocument>('archive_jobs')
      .insertOne({ _id: 'synthetic-job', status: 'running' });
    const seedMs = performance.now() - seedStart;
    // The representative ordering index is non-unique so duplicate fixtures remain valid.
    await db
      .collection('messages')
      .createIndex({ messageId: 1, _id: 1 }, { name: 'benchmark_message_order_v1' });
    const dependencies: RepairDependencies = {
      signal: cancellation.signal,
      planningBatchDocuments: options.batchDocuments,
      policyHash: 'synthetic-policy-v1',
      schemaHash: 'synthetic-schema-v2',
      classify: (document: Record<string, unknown>): 'included' | 'excluded' | 'unknown' =>
        document['authorKind'] === 'bot'
          ? 'excluded'
          : document['authorKind'] === 'human'
            ? 'included'
            : 'unknown',
      assertOwner: async (): Promise<void> => undefined,
      ensureCapacity: async (additionalBytes: number): Promise<void> => {
        // Sum reservations rather than checking one operation in isolation. The service's
        // final whole-journal check is conservatively reserved again to cover growth.
        reservedJournalBytes += additionalBytes;
        if (seedBytes + reservedJournalBytes + 64 * 1024 * 1024 > options.maxDatabaseBytes)
          throw new Error('Synthetic repair journal exceeds database budget');
      },
      withMaintenance: async <T>(operation: () => Promise<T>): Promise<T> => operation(),
      isCancelled: async (jobId: string): Promise<boolean> =>
        cancellation.signal.aborted ||
        (await db!.collection<SyntheticDocument>('archive_jobs').findOne({ _id: jobId }))?.[
          'status'
        ] === 'cancelled',
      backfill: async () => {
        throw new Error('REST backfill is outside this isolated DB benchmark');
      },
    };
    const makeService = () =>
      implementation?.create(connection!, dependencies) ??
      new ArchiveRepairService(connection!, dependencies);
    let service = makeService();
    let plannedRunId: string | undefined;
    const request = (phase: 'audit' | 'plan' | 'verify') => ({
      jobId: 'synthetic-job',
      guildId: '100',
      command: phase,
      options: {},
      ...(phase === 'verify' ? { runId: plannedRunId } : {}),
    });
    // Index preparation never scans messages or creates a manifest before the baseline.
    await db.collection(REPAIR_OPERATIONS).createIndex({ runId: 1, sequence: 1 }, { unique: true });
    await db.collection(REPAIR_RUNS).createIndex({ guildId: 1, status: 1, expiresAt: 1 });
    await db.collection('archive_quarantine').createIndex({ runId: 1, messageId: 1 });
    await db.collection('archive_repair_conflicts').createIndex({ runId: 1 });
    if (options.cache === 'warm') await service.execute(request('audit'));
    for (let run = 1; run <= options.runs; run += 1) {
      for (const phase of ['audit', 'plan', 'verify'] as const) {
        if (phase !== 'verify') {
          await db.collection(REPAIR_OPERATIONS).deleteMany({});
          await db.collection(REPAIR_RUNS).deleteMany({});
        }
        if (options.cache === 'mongo-cold') {
          await connection.close();
          await server.stop({ doCleanup: false });
          // A fresh wrapper avoids accumulating upstream restart event listeners.
          server = await MongoMemoryServer.create({
            binary: { version: '8.2.6' },
            instance: {
              ip: '127.0.0.1',
              dbPath: directory,
              storageEngine: 'wiredTiger',
              args: ['--wiredTigerCacheSizeGB', '0.25'],
            },
          });
          connection = await createConnection(server.getUri('archive_benchmark'), {
            monitorCommands: true,
            maxPoolSize: 4,
            writeConcern: { w: 'majority', j: true },
          }).asPromise();
          db = connection.db;
          if (db === undefined) throw new Error('Disposable benchmark database did not reopen');
          service = makeService();
        }
        reservedJournalBytes = 0;
        const serverStatus = await db.admin().command({ serverStatus: 1 });
        const mongoSampler = new MongoProcessSampler(Number(serverStatus['pid']));
        const metrics = new DatabaseMetrics();
        const client = connection.getClient();
        const stopDatabaseMetrics = metrics.attach(client);
        const sampler = new ArchivePerformanceSampler();
        const liveProbe =
          options.scenario === 'live-updates'
            ? new LiveUpdateProbe(async (sequence) => {
                await db!
                  .collection<SyntheticDocument>('messages')
                  .updateOne(
                    { _id: 'synthetic-000000000000' },
                    { $set: { sourceVersion: sequence } },
                  );
              })
            : undefined;
        sampler.start();
        liveProbe?.start();
        try {
          const result = await service.execute(request(phase));
          if (phase === 'plan') plannedRunId = result.runId;
          const live = await liveProbe?.stop();
          if (live?.failed) throw new Error('Synthetic concurrent update failed');
          const processMetrics = sampler.stop();
          const dbMetrics = stopDatabaseMetrics();
          const mongoProcess = mongoSampler.stop();
          const runState =
            result.runId === undefined
              ? null
              : await db.collection<SyntheticDocument>(REPAIR_RUNS).findOne({ _id: result.runId });
          if (
            result.status === 'failed' ||
            result.status === 'cancelled' ||
            runState?.['status'] === 'failed-plan' ||
            result.issues.some((issue) => issue.includes('exceeds database budget'))
          )
            throw new Error('Synthetic repair run did not complete successfully');
          measurements.push({
            run,
            phase,
            elapsedMs: processMetrics.elapsedMs,
            messagesPerSecond: options.count / (processMetrics.elapsedMs / 1000),
            result: {
              status: result.status,
              counts: result.counts,
              issueCount: result.issues.length,
            },
            process: processMetrics,
            db: dbMetrics,
            liveUpdates: live?.completed ?? 0,
            ...(live === undefined
              ? {}
              : {
                  liveUpdateLatency: {
                    meanMs: live.meanLatencyMs,
                    maximumMs: live.maximumLatencyMs,
                  },
                }),
            mongoProcess,
          });
          process.stderr.write(
            JSON.stringify({
              run,
              phase,
              count: options.count,
              elapsedMs: processMetrics.elapsedMs,
              status: result.status,
            }) + '\n',
          );
        } finally {
          await liveProbe?.stop();
          sampler.stop();
          stopDatabaseMetrics();
          mongoSampler.stop();
        }
      }
    }
    const explain = await db
      .collection('messages')
      .find({})
      .sort({ messageId: 1, _id: 1 })
      .explain('executionStats');
    const stats = await db.stats();
    const buildInfo = await db.admin().command({ buildInfo: 1 });
    const indexes = await db.collection('messages').listIndexes().toArray();
    for (const file of sourceFiles) {
      const hash = createHash('sha256')
        .update(await readFile(resolve(__dirname, '../../src/plugins/message-backup/repair', file)))
        .digest('hex');
      if (hash !== sourceHashes[file])
        throw new Error(
          'Repair source changed during benchmark; rerun against a stable implementation',
        );
    }
    const serviceHash = implementation?.sourceHash ?? sourceHashes['service.ts'];
    const report = {
      version: 1,
      startedAt,
      dataset: {
        version: DATASET_VERSION,
        count: options.count,
        scenario: options.scenario,
        identity: datasetIdentity(options),
        seedBsonBytes: seedBytes,
        maxSeedBatchBytes,
        seedMs,
      },
      implementation: { repairServiceSha256: serviceHash, moduleSha256: sourceHashes },
      environment: {
        node: process.version,
        mongo: buildInfo['version'],
        logicalCpus: cpus().length,
        availableParallelism: availableParallelism(),
        hostRamBytes: totalmem(),
        cgroupCpuMax: await limitFile('/sys/fs/cgroup/cpu.max'),
        cgroupMemoryMax: await limitFile('/sys/fs/cgroup/memory.max'),
        writeConcern: { w: 'majority', j: true },
        maxPoolSize: 4,
        concurrency: 1,
        mongoCacheGiB: 0.25,
        indexVersion: 1,
        batchDocuments: options.batchDocuments,
        indexes: indexes.map((index) => ({
          name: index.name,
          key: index.key,
          unique: index.unique === true,
        })),
        cache: options.cache,
        cacheDefinition:
          'After-seed follows insertion/index preparation; warm adds an audit; mongo-cold restarts only the disposable mongod before each phase to clear its WiredTiger cache. No OS cache eviction is performed.',
      },
      storage: {
        budgetBytes: options.maxDatabaseBytes,
        dataBytes: stats.dataSize,
        allocatedBytes: stats.storageSize,
        indexBytes: stats.indexSize,
        temporaryFilesRemovedOnExit: true,
      },
      syntheticSortExplain: {
        docsExamined: explain['executionStats']?.totalDocsExamined,
        keysExamined: explain['executionStats']?.totalKeysExamined,
        executionTimeMs: explain['executionStats']?.executionTimeMillis,
      },
      summary: Object.fromEntries(
        (['audit', 'plan', 'verify'] as const).map((phase) => [
          phase,
          {
            elapsedMs: summarize(
              measurements.filter((item) => item.phase === phase).map((item) => item.elapsedMs),
            ),
            messagesPerSecond: summarize(
              measurements
                .filter((item) => item.phase === phase)
                .map((item) => item.messagesPerSecond),
            ),
          },
        ]),
      ),
      measurements,
      limitations: [
        'Only actual repair audit/plan/verify database paths execute; no Discord requests, permission discovery, history fetch, reaction membership fetch, worker inbox or shutdown drain are measured.',
        'Reaction-heavy data measures BSON/repair costs, not normal/burst REST completeness.',
        'Many-threads data changes synthetic channel cardinality; permission discovery is not measured.',
        'Node and disposable mongod CPU/RSS are separate process samples; other services and whole-host load are not attributed. Sampling can miss short peaks.',
        'BSON bytes estimate logical command/reply payloads, not wire bytes; instrumentation overhead is included.',
        'No OS cache eviction occurs. Synthetic indexed-sort execution stats do not describe every repair aggregation; journal command latency includes but does not isolate filesystem fsync latency.',
      ],
    };
    if (stats.storageSize + stats.indexSize > options.maxDatabaseBytes)
      throw new Error('Disposable benchmark database exceeded its configured disk budget');
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    return report;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    try {
      await connection?.close();
    } finally {
      try {
        await server?.stop({ doCleanup: true, force: true });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}

if (require.main === module) {
  runBenchmark(parseOptions(process.argv.slice(2)))
    .then((report) => {
      process.stdout.write(
        `${JSON.stringify({ output: parseOptions(process.argv.slice(2)).output, summary: report['summary'] }, null, 2)}\n`,
      );
    })
    .catch(() => {
      // Error text from a driver can contain command data; publish a fixed diagnostic only.
      process.stderr.write(
        'Archive benchmark failed; check options, resource budget and disposable Mongo availability. No report was published.\n',
      );
      process.exitCode = 1;
    });
}
