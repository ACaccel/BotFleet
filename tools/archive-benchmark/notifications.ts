import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createConnection } from 'mongoose';

import { createDefaultTranslator } from '../../src/core/i18n';
import type { ArchiveJob } from '../../src/core/archive/types';
import { renderArchiveBackupPanel } from '../../src/application/archive/panel';
import { ProgressNotifier, ProgressTracker } from '../../src/plugins/message-backup/flow/progress';
import { createCpuBatch, processCpuBatch } from './cpu';
import { summarize } from './metrics';

/** Compare identical normalization and snapshot collection with publication switched on/off. */
export async function benchmarkNotifications(output: string): Promise<void> {
  const server = await MongoMemoryServer.create({
    binary: { version: '8.2.6' },
    instance: { ip: '127.0.0.1', args: ['--wiredTigerCacheSizeGB', '0.25'] },
  });
  const connection = createConnection(server.getUri('archive_notifications'), {
    writeConcern: { w: 'majority', j: true },
    maxPoolSize: 2,
  });
  try {
    await connection.asPromise();
    const jobs = connection.db!.collection<{ _id: string; result: unknown }>('archive_jobs');
    const translator = await createDefaultTranslator({
      localesDir: resolve('src/i18n/locales'),
      fallbackLocale: 'en',
    });
    const batch = createCpuBatch(0, 100, 1024);
    const job: ArchiveJob = {
      jobId: 'synthetic-job',
      requestId: 'synthetic',
      guildId: '1',
      command: 'full-backup',
      options: { cutoff: 0 },
      status: 'running',
      cancelRequested: false,
      createdAt: 0,
    };
    const samples: {
      enabled: boolean;
      elapsedMs: number;
      delivered: number;
      bytes: number;
      durable: number;
    }[] = [];
    for (let repetition = 0; repetition < 4; repetition += 1) {
      for (const enabled of repetition % 2 === 0 ? [false, true] : [true, false]) {
        let now = 1_000_000;
        let delivered = 0;
        let bytes = 0;
        const tracker = new ProgressTracker({ cutoff: new Date(0), clock: () => now });
        tracker.setPhase('history');
        const notifier = new ProgressNotifier<ReturnType<ProgressTracker['snapshot']>>(
          async (snapshot) => {
            await jobs.updateOne(
              { _id: 'synthetic-job' },
              { $set: { result: { progress: snapshot } } },
              { upsert: true },
            );
            const panel = renderArchiveBackupPanel(translator, job, snapshot, {
              now,
              latest: true,
            });
            if ((panel.embeds[0]?.description?.length ?? 0) > 4096)
              throw new Error('Notification exceeds the Discord embed budget');
            bytes += Buffer.byteLength(
              JSON.stringify({ ...panel, allowedMentions: { parse: [] } }),
            );
            delivered += 1;
          },
          5000,
          () => now,
        );
        const start = performance.now();
        try {
          for (let page = 0; page < 1000; page += 1) {
            const result = processCpuBatch(batch);
            tracker.observe('history', result.snapshots.length);
            tracker.commit('history', result.snapshots.length, 'synthetic', page);
            tracker.messageCounts({
              scanned: result.snapshots.length,
              durable: result.snapshots.length,
            });
            now += 50;
            const snapshot = tracker.snapshot();
            if (enabled) await notifier.update(snapshot);
            else await Promise.resolve();
            await yieldTurn();
          }
          if (enabled) await notifier.drain();
          if (repetition > 0)
            samples.push({
              enabled,
              elapsedMs: performance.now() - start,
              delivered,
              bytes,
              durable: tracker.snapshot().messages.durable,
            });
        } finally {
          await notifier.stop();
        }
      }
    }
    const disabled = summarize(
      samples.filter((sample) => !sample.enabled).map((sample) => sample.elapsedMs),
    );
    const enabled = summarize(
      samples.filter((sample) => sample.enabled).map((sample) => sample.elapsedMs),
    );
    await writeFile(
      output,
      JSON.stringify(
        {
          version: 1,
          node: process.version,
          samples,
          disabled,
          enabled,
          throughputLossPercent: 100 * (1 - disabled.median / enabled.median),
          scope:
            '100000 synthetic normalized messages, identical snapshot collection and event-loop yields, actual notifier and English full-backup panel renderer plus isolated Mongo majority/journaled progress writes, 5s cadence over 50s logical clock; first pair warmup excluded. Mock transport encodes payload only; no Discord latency claim.',
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
  void benchmarkNotifications(output).catch(() => {
    process.stderr.write('Notification benchmark failed\n');
    process.exitCode = 1;
  });
}
