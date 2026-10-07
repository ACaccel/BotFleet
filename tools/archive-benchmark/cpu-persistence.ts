import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createConnection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { asGuildId } from '../../src/core/ids';
import { ArchivePerformanceSampler } from '../../src/core/archive/performance';
import { StaticConnectionManager } from '../../src/infra/mongo/connection-manager';
import { MongoArchiveRepo } from '../../src/persistence/repositories/archive.repo';
import { CpuProbeWorker, createCpuBatch, processCpuBatch } from './cpu';
import { summarize } from './metrics';

/** End-to-end adoption gate: worker proposals use the real standalone archive writer. */
async function main(output: string): Promise<void> {
  const server = await MongoMemoryServer.create({
    binary: { version: '8.2.6' },
    instance: { ip: '127.0.0.1', args: ['--wiredTigerCacheSizeGB', '0.25'] },
  });
  const connection = createConnection(server.getUri('archive_cpu_persistence'), {
    writeConcern: { w: 'majority', j: true },
    maxPoolSize: 4,
  });
  try {
    await connection.asPromise();
    const guild = await new StaticConnectionManager(connection).getConnection(asGuildId('1'));
    const indexes: Record<string, unknown[]> = {};
    for (const [name, model] of Object.entries(guild.models)) {
      if (name === 'Message' || name === 'Fetch' || name.startsWith('Archive')) {
        await model.createCollection();
        await model.createIndexes();
        indexes[name] = await model.collection.listIndexes().toArray();
      }
    }
    const repo = new MongoArchiveRepo(guild, 'msg-archive');
    const scenarios = [];
    for (const workload of [
      { count: 2_000, bodyBytes: 64 },
      { count: 500, bodyBytes: 32_768 },
    ]) {
      const variants = [];
      let expected: string | undefined;
      for (const size of [0, 1, 2, 4]) {
        const workers = Array.from({ length: size }, () => new CpuProbeWorker());
        const start = performance.now();
        try {
          await Promise.all(
            workers.map((worker) => worker.run(createCpuBatch(0, 1, workload.bodyBytes))),
          );
          const startupMs = performance.now() - start;
          const samples = [];
          for (let run = 0; run < 3; run += 1) {
            await Promise.all(
              Object.values(guild.models).map((model) =>
                connection.db!.collection(model.collection.name).deleteMany({}),
              ),
            );
            const sampler = new ArchivePerformanceSampler();
            sampler.start();
            try {
              const total = Math.ceil(workload.count / 100);
              for (let sequence = 0; sequence < total; sequence += Math.max(1, size)) {
                const proposals = await Promise.all(
                  Array.from(
                    { length: Math.min(Math.max(1, size), total - sequence) },
                    (_, offset) => {
                      const id = sequence + offset;
                      const input = createCpuBatch(
                        id,
                        Math.min(100, workload.count - id * 100),
                        workload.bodyBytes,
                      );
                      return size === 0 ? processCpuBatch(input) : workers[offset]!.run(input);
                    },
                  ),
                );
                for (const proposal of proposals) {
                  const outcomes = await repo.persistSnapshotsBatch(proposal.snapshots);
                  if (outcomes.some((outcome) => outcome !== 'inserted'))
                    throw new Error('Unexpected archive write outcome');
                }
              }
              const metrics = sampler.stop();
              const digest = createHash('sha256');
              const cursor = guild.models.Message.collection.find({}).sort({ messageId: 1 });
              let count = 0;
              for await (const row of cursor) {
                digest.update(String(row.messageId) + String(row.contentHash));
                count += 1;
              }
              const hash = digest.digest('hex');
              expected ??= hash;
              if (count !== workload.count || hash !== expected)
                throw new Error('CPU persistence output mismatch');
              samples.push({ ...metrics, outputHash: hash, documents: count });
            } finally {
              sampler.stop();
            }
          }
          variants.push({
            size,
            startupMs,
            samples,
            elapsedMs: summarize(samples.map((sample) => sample.elapsedMs)),
          });
        } finally {
          await Promise.all(workers.map((worker) => worker.stop()));
        }
      }
      scenarios.push({ ...workload, variants });
    }
    await writeFile(
      output,
      JSON.stringify(
        {
          version: 1,
          node: process.version,
          mongo: '8.2.6',
          writeConcern: { w: 'majority', j: true },
          indexes,
          scenarios,
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

if (require.main === module) {
  const output = process.argv[2];
  if (output === undefined) throw new Error('Provide a new output report path');
  void main(output).catch(() => {
    process.stderr.write('CPU persistence benchmark failed\n');
    process.exitCode = 1;
  });
}
