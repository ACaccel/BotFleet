import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createConnection } from 'mongoose';
import { normalizeMessage } from '../../src/core/archive/normalize';
import { asGuildId } from '../../src/core/ids';
import { StaticConnectionManager } from '../../src/infra/mongo/connection-manager';
import { MongoArchiveRepo } from '../../src/persistence/repositories/archive.repo';
import { ArchiveRepairService } from '../../src/plugins/message-backup/repair/service';
import type {
  RepairDocument,
  RepairEnrichmentBatchMetric,
  RepairMutation,
} from '../../src/plugins/message-backup/repair/contracts';
import { DatabaseMetrics, summarize } from './metrics';

interface Options {
  count: number;
  runs: number;
  output: string;
}
export function parseEnrichmentOptions(args: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !key ||
      !['--count', '--runs', '--output'].includes(key) ||
      value === undefined ||
      values.has(key)
    )
      throw new Error('Expected unique count, runs and output options');
    values.set(key, value);
  }
  const count = Number(values.get('--count') ?? 120);
  const runs = Number(values.get('--runs') ?? 3);
  const output = values.get('--output');
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 10000 ||
    !Number.isSafeInteger(runs) ||
    runs < 3 ||
    runs > 10 ||
    !output
  )
    throw new Error('Count must be 1..10000, runs 3..10 and output required');
  return { count, runs, output };
}
const snapshot = (index: number, edited: boolean) =>
  normalizeMessage(
    {
      id: String(1000 + index),
      channel_id: '2',
      author: { id: '3', username: 'synthetic', bot: false },
      content: edited && index % 10 === 0 ? 'synthetic changed content' : 'synthetic content',
      timestamp: '2023-11-14T22:13:20.000Z',
      edited_timestamp: edited && index % 10 === 0 ? '2023-11-14T22:13:21.000Z' : null,
      attachments: [],
      embeds: [],
      reactions: [],
    },
    {
      guildId: '1',
      channelName: 'synthetic',
      source: 'history',
      observedAt: edited ? 1700000001000 : 1700000000000,
    },
  );

/** Real repository and recovery journal against an owned disposable server; never accepts a URI. */
export async function runEnrichmentBenchmark(options: Options) {
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      [
        'tools/archive-benchmark/enrichment.ts',
        'src/persistence/repositories/archive.repo.ts',
        'src/plugins/message-backup/repair/service.ts',
        'src/plugins/message-backup/repair/planning-journal.ts',
        'src/plugins/message-backup/repair/apply-batch.ts',
      ].map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(resolve(__dirname, '../..', file)))
          .digest('hex'),
      ]),
    ),
  );
  const server = await MongoMemoryServer.create({
    binary: { version: '8.2.6' },
    instance: {
      ip: '127.0.0.1',
      storageEngine: 'wiredTiger',
      args: ['--wiredTigerCacheSizeGB', '0.25'],
    },
  });
  const results: {
    mode: 'serial' | 'batch';
    run: number;
    elapsedMs: number;
    messagesPerSecond: number;
    commands: number;
    journalOperations: number;
    metrics: RepairEnrichmentBatchMetric;
    digest: string;
    db: ReturnType<DatabaseMetrics['snapshot']>;
  }[] = [];
  try {
    for (let run = 0; run < options.runs; run += 1) {
      for (const mode of (run % 2 === 0 ? ['serial', 'batch'] : ['batch', 'serial']) as (
        | 'serial'
        | 'batch'
      )[]) {
        const connection = await createConnection(server.getUri(`enrichment_${run}_${mode}`), {
          monitorCommands: true,
        }).asPromise();
        try {
          const conn = await new StaticConnectionManager(connection).getConnection(asGuildId('1'));
          const repo = new MongoArchiveRepo(conn, 'msg-archive');
          for (let index = 0; index < options.count; index += 1)
            await repo.persistSnapshot(snapshot(index, false));
          const totals: RepairEnrichmentBatchMetric = {
            operations: 0,
            verified: 0,
            journalMs: 0,
            writeVerifyMs: 0,
          };
          let metrics = totals;
          let elapsedMs = 0;
          let db: ReturnType<DatabaseMetrics['snapshot']> = {};
          const service = new ArchiveRepairService(connection, {
            policyHash: 'synthetic',
            schemaHash: 'archive-v2',
            classify: () => 'included',
            assertOwner: async () => undefined,
            ensureCapacity: async () => undefined,
            withMaintenance: async (operation) => operation(),
            isCancelled: async () => false,
            onEnrichmentBatch: (value) => {
              metrics = {
                operations: metrics.operations + value.operations,
                verified: metrics.verified + value.verified,
                journalMs: metrics.journalMs + value.journalMs,
                writeVerifyMs: metrics.writeVerifyMs + value.writeVerifyMs,
              };
            },
            backfill: async (context) => {
              const monitor = new DatabaseMetrics();
              const stop = monitor.attach(connection.getClient());
              const started = performance.now();
              try {
                for (let offset = 0; offset < options.count; offset += 100) {
                  const page = Array.from(
                    { length: Math.min(100, options.count - offset) },
                    (_, index) => snapshot(offset + index, true),
                  );
                  if (mode === 'serial') {
                    repo.setMutationInterceptor((collection, before, after, reason) =>
                      context.applyMutation(
                        collection,
                        before as RepairDocument | null,
                        after as RepairDocument | null,
                        reason,
                      ),
                    );
                    try {
                      for (const entry of page) {
                        await repo.persistSnapshot(entry);
                        await repo.finalizeReactionRefresh(
                          entry.messageId,
                          'synthetic-empty',
                          [],
                          entry.observedAt,
                        );
                      }
                    } finally {
                      repo.setMutationInterceptor(undefined);
                    }
                  } else {
                    await repo.persistSnapshotsBatch(page, {
                      batchInterceptor: (mutations, beforeWrite) =>
                        context.applyMutations!(
                          mutations as readonly RepairMutation[],
                          beforeWrite,
                        ),
                      snapshotContexts: page.map((entry) => ({
                        emptyReactions: {
                          observedAt: entry.observedAt,
                          assertCurrent: () => undefined,
                        },
                      })),
                    });
                  }
                }
              } finally {
                elapsedMs = performance.now() - started;
                db = stop();
              }
              return { status: 'complete', counts: {}, issues: [] };
            },
          });
          const plan = await service.execute({
            jobId: 'synthetic-plan',
            guildId: '1',
            command: 'plan',
            options: {},
          });
          if (plan.status !== 'complete') throw new Error('Synthetic plan failed');
          const applied = await service.execute({
            jobId: 'synthetic-apply',
            guildId: '1',
            command: 'apply',
            options: {},
            runId: plan.runId,
          });
          if (applied.status !== 'complete')
            throw new Error(`Synthetic apply failed: ${applied.issues.join(', ')}`);
          const messages = await conn.models.Message.collection
            .find({}, { projection: { _id: 0 } })
            .sort({ messageId: 1 })
            .toArray();
          if (
            messages.length !== options.count ||
            messages.some((entry) => entry['reactionsFreshAt'] !== 1700000001000)
          )
            throw new Error('Synthetic freshness verification failed');
          const revisions = await conn.models.ArchiveRevision.countDocuments();
          if (revisions !== Math.ceil(options.count / 10))
            throw new Error('Synthetic revision verification failed');
          const digest = createHash('sha256').update(JSON.stringify(messages)).digest('hex');
          const journalOperations = await connection
            .collection('archive_repair_operations')
            .countDocuments();
          results.push({
            mode,
            run,
            elapsedMs,
            messagesPerSecond: options.count / (elapsedMs / 1000),
            commands: Object.values(db).reduce((sum, metric) => sum + metric.count, 0),
            journalOperations,
            metrics,
            digest,
            db,
          });
          process.stderr.write(
            `Synthetic enrichment ${mode} trial ${run + 1}: ${Math.round(elapsedMs)} ms\n`,
          );
        } finally {
          await connection.dropDatabase();
          await connection.close();
        }
      }
    }
    if (new Set(results.map((result) => result.digest)).size !== 1)
      throw new Error('Serial and batch outputs differ');
    const summary = Object.fromEntries(
      (['serial', 'batch'] as const).map((mode) => {
        const selected = results.filter((result) => result.mode === mode);
        return [
          mode,
          {
            elapsedMs: summarize(selected.map((value) => value.elapsedMs)),
            messagesPerSecond: summarize(selected.map((value) => value.messagesPerSecond)),
            commands: summarize(selected.map((value) => value.commands)),
            journalOperations: summarize(selected.map((value) => value.journalOperations)),
          },
        ];
      }),
    );
    const report = {
      generatedAt: new Date().toISOString(),
      nodeVersion: process.version,
      mongoVersion: '8.2.6',
      sourceHashes,
      count: options.count,
      runs: options.runs,
      workload:
        'Existing human messages, 10% content edits, fresh empty reactions, 100-message pages',
      boundary:
        'Timed repository enrichment and durable journal only; excludes seeding, plan, final verification and Discord REST. Serial uses separate snapshot+empty finalize; batch folds empty freshness into snapshot.',
      summary,
      results,
    };
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    return report;
  } finally {
    await server.stop({ doCleanup: true, force: true });
  }
}
if (require.main === module) {
  runEnrichmentBenchmark(parseEnrichmentOptions(process.argv.slice(2)))
    .then((report) => process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`))
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'Synthetic benchmark failed'}\n`,
      );
      process.exitCode = 1;
    });
}
