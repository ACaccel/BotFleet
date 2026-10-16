import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { ArchiveScheduler } from '../../src/plugins/message-backup/flow/scheduler';
import { summarize } from './metrics';

/** Deterministic demand and quotas; no HTTP requests or Discord credentials are used. */
async function measure(concurrency: number, blocked: boolean) {
  const scheduler = new ArchiveScheduler({ concurrency, maxQueued: 128 });
  const calls = 80;
  const serviceMs = 10;
  const active = new Set<string>();
  const guildCompletions: Record<string, number> = {};
  let collisions = 0;
  let liveLatencyMs = 0;
  const started = performance.now();
  if (blocked)
    scheduler.observeWait({
      global: false,
      bucketKey: 'synthetic:0',
      channelId: '0',
      deadlineAt: Date.now() + 100,
    });
  try {
    const background = Array.from({ length: calls }, (_, index) => {
      const resourceId = String(index % 4);
      const guildId = String(index % 2);
      return scheduler.run(
        `probe:${index}`,
        index % 3 === 0 ? 'enrichment' : 'history',
        async () => {
          if (active.has(resourceId)) collisions += 1;
          active.add(resourceId);
          try {
            await delay(serviceMs);
          } finally {
            active.delete(resourceId);
          }
          guildCompletions[guildId] = (guildCompletions[guildId] ?? 0) + 1;
        },
        { resource: { channelId: resourceId }, guildId },
      );
    });
    const liveStart = performance.now();
    const live = scheduler.run(
      'control',
      'live',
      async () => {
        liveLatencyMs = performance.now() - liveStart;
      },
      { guildId: 'control', resource: { channelId: 'control' } },
    );
    await Promise.all([...background, live]);
    const elapsedMs = performance.now() - started;
    if (collisions !== 0 || Object.values(guildCompletions).some((count) => count !== 40))
      throw new Error('REST admission fairness or per-resource limit failed');
    return {
      elapsedMs,
      liveLatencyMs,
      usefulRequestsPerSecond: (calls * 1000) / elapsedMs,
      theoreticalServiceMs: (calls * serviceMs) / 4,
      collisions,
      guildCompletions,
      scheduler: scheduler.snapshot(),
    };
  } finally {
    scheduler.stop();
  }
}

async function main(output: string): Promise<void> {
  const variants = [];
  for (const blocked of [false, true]) {
    for (const concurrency of [2, 4, 8]) {
      const samples = [];
      for (let run = 0; run < 3; run += 1) samples.push(await measure(concurrency, blocked));
      variants.push({
        blocked,
        concurrency,
        samples,
        elapsedMs: summarize(samples.map((sample) => sample.elapsedMs)),
      });
    }
  }
  await writeFile(
    output,
    JSON.stringify(
      {
        version: 1,
        scope:
          'Synthetic four independent resource buckets with one request each, 10ms service; optional observed local wait. No real HTTP 429 or Discord traffic.',
        variants,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
}

if (require.main === module) {
  const output = process.argv[2];
  if (output === undefined) throw new Error('Provide a new output report path');
  void main(output).catch(() => {
    process.stderr.write('REST admission benchmark failed\n');
    process.exitCode = 1;
  });
}
