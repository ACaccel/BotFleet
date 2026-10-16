import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { mongo } from 'mongoose';
import { ArchivePerformanceSampler } from '../../src/core/archive/performance';
import { normalizeMessage } from '../../src/core/archive/normalize';
import type { ArchiveSnapshot } from '../../src/core/archive/types';
import { summarize } from './metrics';

interface CpuBatch {
  version: 1;
  sequence: number;
  bytes: Uint8Array;
}
interface CpuReply {
  sequence: number;
  hashes: string[];
  snapshots: ArchiveSnapshot[];
}

/** BSON is the transport contract; raw structured clone would lose BSON prototypes. */
export function processCpuBatch(batch: CpuBatch): CpuReply {
  if (batch.version !== 1) throw new Error('Unsupported CPU benchmark transport');
  const { documents } = mongo.BSON.deserialize(batch.bytes) as {
    documents: Record<string, unknown>[];
  };
  const snapshots = documents.map((raw) =>
    normalizeMessage(raw, { observedAt: 1_700_000_000_000 }),
  );
  const hashes = documents.map((raw, index) => {
    const snapshot = snapshots[index]!;
    return (
      createHash('sha256').update(mongo.BSON.serialize(snapshot)).digest('hex') +
      createHash('sha256').update(mongo.BSON.serialize(raw)).digest('hex')
    );
  });
  return { sequence: batch.sequence, hashes, snapshots };
}

export class CpuProbeWorker {
  readonly worker: Worker;
  private pending:
    | {
        resolve(value: CpuReply): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  private failed: Error | undefined;
  constructor() {
    this.worker = new Worker(__filename, {
      env: {},
      execArgv: ['-r', require.resolve('ts-node/register')],
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    this.worker.on('message', (value: CpuReply) => {
      const pending = this.pending;
      this.pending = undefined;
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        pending.resolve(value);
      }
    });
    const fail = (error: Error): void => {
      this.failed = error;
      const pending = this.pending;
      this.pending = undefined;
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
    };
    this.worker.on('error', fail);
    this.worker.on('exit', (code) => fail(new Error(`CPU benchmark worker exited (${code})`)));
  }
  run(batch: CpuBatch): Promise<CpuReply> {
    if (this.failed !== undefined) return Promise.reject(this.failed);
    if (this.pending !== undefined) return Promise.reject(new Error('CPU benchmark queue is full'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        const error = new Error('CPU benchmark worker timed out');
        this.failed = error;
        reject(error);
        void this.worker.terminate();
      }, 60_000);
      this.pending = { resolve, reject, timer };
      this.worker.postMessage(batch, [batch.bytes.buffer as ArrayBuffer]);
    });
  }
  async stop(): Promise<void> {
    await this.worker.terminate();
  }
}

export function createCpuBatch(sequence: number, count: number, bodyBytes: number): CpuBatch {
  const documents = Array.from({ length: count }, (_, offset) => ({
    id: String(1_000_000_000_000_000_000n + BigInt(sequence * 100 + offset)),
    channel_id: '2',
    author: { id: '3', username: 'Synthetic', bot: false },
    timestamp: '2023-11-14T22:13:20.000Z',
    content: 'x'.repeat(bodyBytes),
    embeds: [{ title: 'Synthetic', fields: [{ name: 'n', value: 'v' }] }],
    _id: new mongo.ObjectId('000000000000000000000001'),
    transportDate: new Date(1_700_000_000_000),
    transportBuffer: Buffer.from([1, 2, 3]),
  }));
  const bytes = Uint8Array.from(mongo.BSON.serialize({ documents }));
  if (bytes.byteLength > 4 * 1024 * 1024) throw new Error('CPU batch exceeds byte budget');
  return { version: 1, sequence, bytes };
}

async function runProbe(size: number, count: number, bodyBytes: number) {
  const workers = Array.from({ length: size }, () => new CpuProbeWorker());
  const startup = performance.now();
  try {
    await Promise.all(workers.map((worker) => worker.run(createCpuBatch(0, 1, bodyBytes))));
    const startupMs = performance.now() - startup;
    const repetitions = [];
    for (let repeat = 0; repeat < 3; repeat += 1) {
      const sampler = new ArchivePerformanceSampler();
      const digest = createHash('sha256');
      sampler.start();
      try {
        const batches = Math.ceil(count / 100);
        for (let sequence = 0; sequence < batches; sequence += Math.max(1, size)) {
          const requests = Array.from(
            { length: Math.min(Math.max(1, size), batches - sequence) },
            (_, index) => {
              const id = sequence + index;
              const input = createCpuBatch(id, Math.min(100, count - id * 100), bodyBytes);
              return size === 0
                ? Promise.resolve(processCpuBatch(input))
                : workers[index]!.run(input);
            },
          );
          const results = await Promise.all(requests);
          for (let index = 0; index < results.length; index += 1) {
            const result = results[index]!;
            if (result.sequence !== sequence + index)
              throw new Error('CPU result sequence mismatch');
            for (const hash of result.hashes) digest.update(hash);
          }
        }
        repetitions.push({ ...sampler.stop(), digest: digest.digest('hex') });
      } finally {
        sampler.stop();
      }
    }
    return {
      size,
      startupMs,
      repetitions,
      elapsedMs: summarize(repetitions.map((item) => item.elapsedMs)),
    };
  } finally {
    await Promise.all(workers.map((worker) => worker.stop()));
  }
}

export async function benchmarkCpu(output: string): Promise<void> {
  const variants = [];
  for (const workload of [
    { count: 20_000, bodyBytes: 64 },
    { count: 5_000, bodyBytes: 32_768 },
  ]) {
    const pools = [];
    for (const size of [0, 1, 2, 4])
      pools.push(await runProbe(size, workload.count, workload.bodyBytes));
    const expected = pools[0]!.repetitions[0]!.digest;
    if (pools.some((pool) => pool.repetitions.some((sample) => sample.digest !== expected)))
      throw new Error('CPU worker output differs from owner output');
    variants.push({ ...workload, pools });
  }
  await writeFile(
    output,
    JSON.stringify(
      {
        version: 1,
        node: process.version,
        availableParallelism: availableParallelism(),
        batchDocuments: 100,
        batchByteLimit: 4 * 1024 * 1024,
        maxInFlightBatches: 4,
        variants,
        scope:
          'Synthetic normalization/content hash/BSON hash; owner encoding and worker round trips included, startup separately reported. No Discord, DB writes or bot credentials.',
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
}

if (!isMainThread) {
  parentPort!.on('message', (input: CpuBatch) => parentPort!.postMessage(processCpuBatch(input)));
} else if (require.main === module) {
  const output = process.argv[2];
  if (output === undefined) throw new Error('Provide a new output report path');
  void benchmarkCpu(output).catch(() => {
    process.stderr.write('CPU benchmark failed\n');
    process.exitCode = 1;
  });
}
