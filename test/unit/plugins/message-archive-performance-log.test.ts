import { describe, expect, it } from 'vitest';

import { ArchiveBackpressureError } from '../../../src/core/archive/errors';
import {
  ARCHIVE_LIMITS,
  archiveConcurrencySchema,
  archiveQueueLimit,
} from '../../../src/core/archive/limits';
import { scrubForLog } from '../../../src/core/logger/scrub-for-log';
import {
  archivePerformanceLog,
  type ArchivePerformanceLog,
} from '../../../src/plugins/message-backup/flow/performance-log';
import {
  ARCHIVE_PIPELINE_STAGES,
  ArchivePipelineBudget,
} from '../../../src/plugins/message-backup/flow/pipeline';
import { ArchiveRestTelemetry } from '../../../src/plugins/message-backup/flow/rest-telemetry';
import { ArchiveScheduler } from '../../../src/plugins/message-backup/flow/scheduler';

/** Every leaf of a scrubbed log object, with its dotted path. */
const leaves = (value: unknown, path = ''): [string, unknown][] =>
  typeof value === 'object' && value !== null
    ? Object.entries(value).flatMap(([key, child]) =>
        leaves(child, path === '' ? key : `${path}.${key}`),
      )
    : [[path, value]];

const wait = {
  hash: 'bucket',
  majorParameter: '10',
  route: '/channels/:id/messages',
  timeToReset: 0,
  sublimitTimeout: 0,
};

describe('archive pipeline performance log', () => {
  it('reports every recorded stage with real numbers after the logger scrubber', async () => {
    const budget = new ArchivePipelineBudget(16);
    ARCHIVE_PIPELINE_STAGES.forEach((stage, index) => budget.record(stage, 10 + index, index));
    const history = await budget.reserve(6);
    const reaction = await budget.reserve(2, undefined, 'reactions');
    const queuedReaction = budget.reserve(1, undefined, 'reactions');
    const telemetry = new ArchiveRestTelemetry(() => 1_000_000);
    telemetry.response(200, null);
    telemetry.response(429, 'global', 'true');
    telemetry.response(429, 'user');
    telemetry.response(429, 'shared');
    telemetry.wait({ ...wait, retryAfter: 250, global: true });
    telemetry.wait({ ...wait, retryAfter: 40 });
    const scheduler = new ArchiveScheduler({ concurrency: 2 });

    const payload = archivePerformanceLog(
      budget.snapshot(),
      telemetry.snapshot(),
      scheduler.snapshot(),
    );
    const scrubbed = scrubForLog(payload) as ArchivePerformanceLog;

    expect(leaves(scrubbed).filter(([, value]) => value === '[Redacted]')).toEqual([]);
    expect(scrubbed).toEqual(payload);
    expect(Object.keys(scrubbed.stages)).toEqual([
      'fetch',
      'normalize',
      'write',
      'reactions',
      'checkpoint',
      'process',
    ]);
    expect(scrubbed.stages.process).toEqual({ count: 1, durationMs: 15, bytes: 5 });
    expect(scrubbed.pipeline).toMatchObject({
      historyReservedBytes: 6,
      reactionReservedBytes: 2,
      reservedBytes: 8,
      waiting: 1,
      historyWaiting: 0,
      reactionWaiting: 1,
    });
    expect(scrubbed.pipeline).not.toHaveProperty('stages');
    expect(scrubbed.scheduler).toEqual({
      active: 0,
      queued: 0,
      background: 0,
      waitingResources: 0,
      globalWait: false,
    });
    expect(scrubbed.rateLimits).toEqual({
      responses: 4,
      global429: 1,
      route429: 1,
      shared429: 1,
      unknown429: 0,
      waitEvents: 2,
      waitMs: 290,
      globalWaitMs: 250,
      routeWaitMs: 40,
      invalidLast10Minutes: 2,
    });

    reaction();
    (await queuedReaction)();
    history();
  });
});

describe('archive queue bounds', () => {
  it('accepts readers up to the raised maximum only', () => {
    expect(ARCHIVE_LIMITS.concurrency.maximum).toBe(32);
    expect(archiveConcurrencySchema.safeParse(32).success).toBe(true);
    expect(archiveConcurrencySchema.safeParse(33).success).toBe(false);
    expect(() => new ArchiveScheduler({ concurrency: 33 })).toThrow('invalid-archive-concurrency');
  });

  it('keeps the old headroom at eight readers and scales it beyond', () => {
    expect(archiveQueueLimit(1)).toBe(128);
    expect(archiveQueueLimit(8)).toBe(128);
    expect(archiveQueueLimit(32)).toBe(512);
  });

  it('sizes scheduler backpressure from its concurrency unless set explicitly', async () => {
    const fill = (scheduler: ArchiveScheduler, count: number): Promise<unknown>[] =>
      Array.from({ length: count }, (_, index) =>
        scheduler.run(`history:${index}:a`, 'history', async () => index),
      );
    const scaled = new ArchiveScheduler({ concurrency: 32 });
    scaled.pauseBackground();
    const queued = fill(scaled, 512);
    expect(scaled.snapshot().queued).toBe(512);
    await expect(scaled.run('history:overflow:a', 'history', async () => 0)).rejects.toThrow(
      ArchiveBackpressureError,
    );
    const explicit = new ArchiveScheduler({ concurrency: 32, maxQueued: 2 });
    explicit.pauseBackground();
    const capped = fill(explicit, 2);
    await expect(explicit.run('history:overflow:a', 'history', async () => 0)).rejects.toThrow(
      'archive-read-queue-full',
    );
    expect(() => new ArchiveScheduler({ maxQueued: 0 })).toThrow('invalid-archive-queue-limit');
    scaled.stop();
    explicit.stop();
    await Promise.allSettled([...queued, ...capped]);
  });

  it('bounds waiting byte reservations by the configured queue limit', async () => {
    expect(() => new ArchivePipelineBudget(16, 0)).toThrow('invalid-archive-pipeline-queue-limit');
    const budget = new ArchivePipelineBudget(16, 2);
    const held = await budget.reserve(14);
    const first = budget.reserve(14);
    const second = budget.reserve(14);
    await expect(budget.reserve(14)).rejects.toThrow('archive-pipeline-queue-full');
    expect(budget.snapshot()).toMatchObject({ waiting: 2, historyWaiting: 2, reactionWaiting: 0 });
    held();
    (await first)();
    (await second)();
    expect(budget.snapshot().reservedBytes).toBe(0);
  });
});
