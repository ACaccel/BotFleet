import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createConnection, mongo } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { normalizeMessage } from '../../src/core/archive/normalize';
import type { ArchiveMessage } from '../../src/core/archive/types';
import { asGuildId } from '../../src/core/ids';
import { StaticConnectionManager } from '../../src/infra/mongo/connection-manager';
import { buildArchiveWriterRepos } from '../../src/persistence/repositories/archive-repos';
import { DatabaseMetrics, summarize } from './metrics';

/**
 * Freshness-only re-observation probe: the same fenced write of `observedAt` as a
 * full replacement and as a `$set`, in 100-document ordered bulk writes, on
 * messages of a realistic size; then the repository's batch path on identical
 * re-observations for reference. Variants alternate across runs.
 */
const raw = (index: number): Record<string, unknown> => ({
  id: String(1_100_000_000_000_000_000n + BigInt(index)),
  channel_id: '100000000000000001',
  type: 0,
  author: { id: '300000000000000001', username: 'member', global_name: 'Member', bot: false },
  content: `synthetic message ${index} `.repeat(30),
  timestamp: new Date(1_700_000_000_000 + index * 1000).toISOString(),
  edited_timestamp: null,
  mentions: [],
  mention_roles: [],
  attachments: [
    {
      id: String(1_200_000_000_000_000_000n + BigInt(index)),
      filename: 'image.png',
      size: 120_000,
      url: 'https://cdn.discordapp.com/attachments/1/2/image.png?ex=1&is=2&hm=3',
      proxy_url: 'https://media.discordapp.net/attachments/1/2/image.png',
      content_type: 'image/png',
      width: 800,
      height: 600,
    },
  ],
  embeds: [
    {
      type: 'rich',
      title: 'A linked page',
      description: 'A description of the linked page. '.repeat(8),
      url: 'https://example.com/page',
    },
  ],
});

async function main(output: string, count: number, runs: number): Promise<void> {
  const server = await MongoMemoryServer.create({
    binary: { version: '8.2.6' },
    instance: { ip: '127.0.0.1', args: ['--wiredTigerCacheSizeGB', '0.25'] },
  });
  const connection = createConnection(server.getUri('archive_reobserve_probe'), {
    writeConcern: { w: 'majority', j: true },
    maxPoolSize: 4,
    monitorCommands: true,
  });
  try {
    await connection.asPromise();
    const guild = await new StaticConnectionManager(connection).getConnection(asGuildId('1'));
    await guild.models.Message.createCollection();
    await guild.models.Message.createIndexes();
    const repo = buildArchiveWriterRepos(guild).messages;
    const snapshots = Array.from({ length: count }, (_, index) =>
      normalizeMessage(raw(index), { observedAt: 1_700_000_000_000 + index }),
    );
    for (let offset = 0; offset < count; offset += 500)
      await repo.persistSnapshotsBatch(snapshots.slice(offset, offset + 500));
    const collection = connection.collection<ArchiveMessage & Record<string, unknown>>('messages');
    const documentBytes = mongo.BSON.calculateObjectSize((await collection.findOne({}))!);
    let tick = 0;
    const fenced = async (mode: 'replace' | 'update'): Promise<void> => {
      tick += 1;
      for (let offset = 0; offset < count; offset += 100) {
        const before = await collection
          .find({ _id: { $in: snapshots.slice(offset, offset + 100).map((item) => item._id) } })
          .toArray();
        const writes = before.map((document) => {
          const filter = {
            _id: { $eq: document._id },
            $expr: { $eq: ['$$ROOT', { $literal: document }] },
          };
          const observedAt = (document.observedAt ?? 0) + tick;
          return mode === 'replace'
            ? { replaceOne: { filter, replacement: { ...document, observedAt } } }
            : { updateOne: { filter, update: { $set: { observedAt } } } };
        });
        const result = await collection.bulkWrite(writes, {
          ordered: true,
          writeConcern: { w: 1, j: true },
        });
        if (result.matchedCount !== writes.length) throw new Error('Probe write conflict');
      }
    };
    const variants: Record<string, { elapsedMs: number[]; requestBytes: number[] }> = {
      replace: { elapsedMs: [], requestBytes: [] },
      update: { elapsedMs: [], requestBytes: [] },
      repository: { elapsedMs: [], requestBytes: [] },
    };
    const measure = async (name: string, work: () => Promise<void>): Promise<void> => {
      const stop = new DatabaseMetrics().attach(connection.getClient());
      const started = performance.now();
      await work();
      const elapsed = performance.now() - started;
      const metrics = stop();
      variants[name]!.elapsedMs.push(elapsed);
      variants[name]!.requestBytes.push(
        Object.values(metrics).reduce((sum, metric) => sum + metric.requestBsonBytes, 0),
      );
    };
    for (let run = 0; run < runs; run += 1) {
      const order =
        run % 2 === 0 ? (['replace', 'update'] as const) : (['update', 'replace'] as const);
      for (const mode of order) await measure(mode, () => fenced(mode));
      // Later than every stored freshness, so the outcome stays `unchanged`.
      const observedAt = 2_000_000_000_000 + run * 1_000_000;
      await measure('repository', async () => {
        for (let offset = 0; offset < count; offset += 100) {
          const outcomes = await repo.persistSnapshotsBatch(
            snapshots.slice(offset, offset + 100).map((item) => ({ ...item, observedAt })),
          );
          if (outcomes.some((outcome) => outcome !== 'unchanged'))
            throw new Error(`Unexpected re-observation outcome ${outcomes.join(',')}`);
        }
      });
    }
    const report = {
      version: 1,
      node: process.version,
      mongo: '8.2.6',
      count,
      documentBytes,
      variants: Object.fromEntries(
        Object.entries(variants).map(([name, value]) => [
          name,
          {
            elapsedMs: summarize(value.elapsedMs),
            requestBytes: summarize(value.requestBytes),
            samples: value,
          },
        ]),
      ),
    };
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    for (const [name, value] of Object.entries(report.variants))
      process.stdout.write(
        `${name} ${JSON.stringify({ elapsedMs: value.elapsedMs, requestBytes: value.requestBytes })}\n`,
      );
  } finally {
    await connection.close();
    await server.stop({ doCleanup: true, force: true });
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
  void main(resolve(output), Number(flag('count', '20000')), Number(flag('runs', '3'))).catch(
    (error: unknown) => {
      process.stderr.write(`Re-observation benchmark failed: ${String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
