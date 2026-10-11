import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createConnection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ArchiveStorageSampler, measureStorageRoots } from '../../src/infra/archive/storage-usage';
import { ArchiveStorageMonitor } from '../../src/plugins/message-backup/runtime/storage-monitor';
import { summarize } from './metrics';

/**
 * Capacity sampling probe: a synthetic static tree (standing in for the project,
 * runtime and release directories) plus a live MongoDB 8.2.6 data directory.
 * `walkMs` times a walk of every root; `sampler` times the first and later samples
 * of `ArchiveStorageSampler`, which reuses the stable roots' size. `admission`
 * issues a small reservation every 25 ms while the monitor's samples expire, as
 * writer turns do, and reports their latency for both measurements.
 */
interface StorageProbeOptions {
  readonly files: number;
  readonly admissionSeconds: number;
  readonly maxAgeMs: number;
}

const percentile = (values: readonly number[], share: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0;
};

const staticTree = async (root: string, files: number): Promise<void> => {
  const perDirectory = 200;
  for (let directory = 0; directory * perDirectory < files; directory += 1) {
    const path = join(root, `d${Math.floor(directory / 50)}`, `p${directory}`);
    await mkdir(path, { recursive: true });
    await Promise.all(
      Array.from({ length: Math.min(perDirectory, files - directory * perDirectory) }, (_, index) =>
        writeFile(join(path, `f${index}`), 'x'),
      ),
    );
  }
};

async function main(output: string, options: StorageProbeOptions): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'archive-storage-probe-'));
  const server = await MongoMemoryServer.create({
    binary: { version: '8.2.6' },
    instance: { ip: '127.0.0.1', args: ['--wiredTigerCacheSizeGB', '0.25'] },
  });
  const connection = createConnection(server.getUri('archive_storage_probe'));
  try {
    await connection.asPromise();
    const staticRoot = join(root, 'static');
    const treeStarted = performance.now();
    await staticTree(staticRoot, options.files);
    const treeMs = performance.now() - treeStarted;
    // Some collections give the data directory a realistic set of WiredTiger files.
    for (let index = 0; index < 20; index += 1)
      await connection
        .collection(`probe_${index}`)
        .insertMany(Array.from({ length: 200 }, (_, value) => ({ value, body: 'x'.repeat(200) })));
    const dbPath = server.instanceInfo?.dbPath;
    if (dbPath === undefined) throw new Error('Memory server has no dbPath');
    const roots = [staticRoot, dbPath];
    const walks: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      await measureStorageRoots(roots);
      walks.push(performance.now() - started);
    }
    const sampler = new ArchiveStorageSampler({
      resolveRoots: async () => ({ stable: [staticRoot], live: [dbPath] }),
    });
    const firstStarted = performance.now();
    await sampler.sample();
    const samplerFirstMs = performance.now() - firstStarted;
    const steady: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      await sampler.sample();
      steady.push(performance.now() - started);
    }
    const admission = async (measure: () => ReturnType<typeof measureStorageRoots>) => {
      const monitor = new ArchiveStorageMonitor(measure, {
        budgetBytes: 100_000_000_000,
        backgroundLimitBytes: 85_000_000_000,
        reserveBytes: 5_000_000_000,
        maxAgeMs: options.maxAgeMs,
      });
      const latencies: number[] = [];
      let failures = 0;
      const deadline = performance.now() + options.admissionSeconds * 1000;
      monitor.start();
      try {
        while (performance.now() < deadline) {
          const started = performance.now();
          try {
            await monitor.withReservation(4096, false, async () => undefined);
          } catch {
            failures += 1;
          }
          latencies.push(performance.now() - started);
          await new Promise((done) => setTimeout(done, 25));
        }
      } finally {
        await monitor.stop();
      }
      return {
        reservations: latencies.length,
        failures,
        p50Ms: percentile(latencies, 0.5),
        p99Ms: percentile(latencies, 0.99),
        maxMs: Math.max(...latencies),
        over100Ms: latencies.filter((latency) => latency > 100).length,
      };
    };
    const report = {
      version: 2,
      node: process.version,
      mongo: '8.2.6',
      options,
      treeMs,
      walkMs: summarize(walks),
      sampler: { firstMs: samplerFirstMs, steadyMs: summarize(steady) },
      admission: {
        fullWalk: await admission(() => measureStorageRoots(roots)),
        sampler: await admission(() => sampler.sample()),
      },
    };
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write(
      `${JSON.stringify({ walkMs: report.walkMs, sampler: report.sampler, admission: report.admission })}\n`,
    );
  } finally {
    await connection.close();
    await server.stop({ doCleanup: true, force: true });
    await rm(root, { recursive: true, force: true });
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
  void main(resolve(output), {
    files: Number(flag('files', '100000')),
    admissionSeconds: Number(flag('seconds', '20')),
    maxAgeMs: Number(flag('max-age', '2000')),
  }).catch((error: unknown) => {
    process.stderr.write(`Storage benchmark failed: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
