import { describe, expect, it, vi } from 'vitest';

import {
  ArchiveScheduler,
  mapArchiveChannels,
  runArchiveSources,
} from '../../../src/plugins/message-backup/flow/scheduler';
import {
  KnownPhaseEstimator,
  ProgressTracker,
  ProgressNotifier,
} from '../../../src/plugins/message-backup/flow/progress';
import { fetchReactionMemberships } from '../../../src/plugins/message-backup/flow/reactions';
import {
  historyBefore,
  inHistoryScope,
} from '../../../src/plugins/message-backup/flow/history-boundary';
import {
  estimatePeriodicWork,
  updatePeriodicHistory,
} from '../../../src/plugins/message-backup/flow/periodic-estimate';
import { restDiscoveryAdapter } from '../../../src/plugins/message-backup/flow/rest-discovery';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('bounds independent workers and preserves result ordering', async () => {
  let active = 0;
  let peak = 0;
  const result = await mapArchiveChannels(
    [1, 2, 3, 4],
    async (value) => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return value * 2;
    },
    2,
  );
  expect(result).toEqual([2, 4, 6, 8]);
  expect(peak).toBe(2);
});
describe('retrying source runner', () => {
  it('runs a retried source again at the tail without holding a worker', async () => {
    const runs: string[] = [];
    let failedOnce = false;
    await runArchiveSources(
      ['a', 'b', 'c'],
      async (value) => {
        runs.push(value);
        if (value === 'a' && !failedOnce) {
          failedOnce = true;
          return 1;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        return undefined;
      },
      1,
    );
    expect(runs).toEqual(['a', 'b', 'c', 'a']);
  });

  it('waits for a pending retry once every other source is done', async () => {
    const runs: string[] = [];
    await runArchiveSources(
      ['a', 'b'],
      async (value) => {
        runs.push(value);
        return runs.filter((run) => run === value).length < 3 ? 2 : undefined;
      },
      2,
    );
    expect(runs.filter((run) => run === 'a')).toHaveLength(3);
    expect(runs.filter((run) => run === 'b')).toHaveLength(3);
  });

  it('drops waiting retries on abort and validates concurrency', async () => {
    const controller = new AbortController();
    const worker = vi.fn(async () => {
      controller.abort();
      return 60_000;
    });
    const started = Date.now();
    await runArchiveSources(['a'], worker, 1, controller.signal);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(worker).toHaveBeenCalledTimes(1);
    await expect(runArchiveSources(['a'], worker, 0)).rejects.toThrow(
      'invalid-archive-concurrency',
    );
  });

  it('drops a retry scheduled while a worker waits for another', async () => {
    const controller = new AbortController();
    const runs: string[] = [];
    const run = runArchiveSources(
      ['a', 'b'],
      async (value) => {
        runs.push(value);
        if (value === 'b') await new Promise((resolve) => setTimeout(resolve, 5));
        return 60_000;
      },
      2,
      controller.signal,
    );
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    controller.abort();
    await run;
    expect(runs).toEqual(['a', 'b']);
  });
});

describe('worker failure settlement', () => {
  const failFirst = async (
    run: (values: string[], worker: (value: string) => Promise<undefined>) => Promise<unknown>,
  ) => {
    const events: string[] = [];
    const slow = deferred<void>();
    const outcome = run(['a', 'b', 'c', 'd'], async (value) => {
      events.push(`start:${value}`);
      if (value === 'a') throw new Error('a failed');
      if (value === 'b') await slow.promise;
      events.push(`end:${value}`);
      return undefined;
    }).then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(events).toContain('start:b'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The failure waits for the source still running.
    expect(settled).toBe(false);
    slow.resolve();
    expect(await outcome).toBe('a failed');
    return events;
  };

  it('settles running sources before rethrowing and dispatches no more', async () => {
    const events = await failFirst((values, worker) => runArchiveSources(values, worker, 2));
    expect(events).toEqual(['start:a', 'start:b', 'end:b']);
  });

  it('settles running channels before rethrowing and dispatches no more', async () => {
    const events = await failFirst((values, worker) => mapArchiveChannels(values, worker, 2));
    expect(events).toEqual(['start:a', 'start:b', 'end:b']);
  });
});

describe('REST admission scheduler', () => {
  it('keeps announced route waits for every read its queue can hold', () => {
    const wait = (index: number) => ({
      channelId: String(index),
      route: 'messages' as const,
      bucketKey: `bucket-${index}`,
      global: false,
      deadlineAt: Date.now() + 60_000,
    });
    const scaled = new ArchiveScheduler({ concurrency: 32 });
    for (let index = 0; index < 300; index += 1) scaled.observeWait(wait(index));
    expect(scaled.snapshot().waitingResources).toBe(300);
    const explicit = new ArchiveScheduler({ concurrency: 32, maxQueued: 4 });
    for (let index = 0; index < 10; index += 1) explicit.observeWait(wait(index));
    expect(explicit.snapshot().waitingResources).toBe(4);
    scaled.stop();
    explicit.stop();
  });

  it('shares same-generation reads, reserves a live slot and bounds queued work', async () => {
    const scheduler = new ArchiveScheduler({ concurrency: 1, maxQueued: 1 });
    const first = deferred<number>();
    const read = vi.fn(() => first.promise);
    const background = scheduler.run('a', 'history', read);
    expect(scheduler.run('a', 'history', read)).toBe(background);
    const queued = scheduler.run('b', 'enrichment', async () => 2);
    await expect(scheduler.run('c', 'history', async () => 3)).rejects.toThrow('queue-full');
    // Full background queues backpressure all admissions; complete the page before accepting live work.
    first.resolve(1);
    await background;
    await queued;
    expect(read).toHaveBeenCalledTimes(1);
    expect(await scheduler.run('live', 'live', async () => 4)).toBe(4);
  });
  it('paused background work yields to live reads and resumes', async () => {
    const scheduler = new ArchiveScheduler();
    scheduler.pauseBackground();
    const background = scheduler.run('a', 'history', async () => 1);
    expect(await scheduler.run('live', 'live', async () => 2)).toBe(2);
    expect(scheduler.snapshot().queued).toBe(1);
    scheduler.resumeBackground();
    expect(await background).toBe(1);
  });
  it('keeps distinct generations separate and stops after invalid credentials', async () => {
    const scheduler = new ArchiveScheduler();
    await expect(
      scheduler.run('bad', 'history', async () => {
        throw { status: 401 };
      }),
    ).rejects.toEqual({ status: 401 });
    await expect(scheduler.run('later', 'history', async () => 1)).rejects.toThrow(
      'invalid-credentials',
    );
  });
  it('cancels a queued cursor without touching another consumer', async () => {
    const scheduler = new ArchiveScheduler();
    scheduler.pauseBackground();
    const abort = new AbortController();
    const work = vi.fn(async () => 1);
    const result = scheduler.run('a', 'history', work, { signal: abort.signal });
    abort.abort();
    await expect(result).rejects.toThrow('cancelled');
    expect(work).not.toHaveBeenCalled();
  });
});

describe('acknowledged ETA and cutoff', () => {
  it('keeps unknown run scope separate from warmed-up phase estimates; deduplicates replay', () => {
    let now = 0;
    const tracker = new ProgressTracker({ cutoff: new Date('2026-01-01'), clock: () => now });
    tracker.setPhase('history');
    tracker.setTotal('history', 100);
    for (let page = 0; page < 3; page++) {
      now += 1000;
      tracker.commit('history', 10, 'channel', page);
    }
    expect(tracker.commit('history', 10, 'channel', 2)).toBe(false);
    const status = tracker.snapshot();
    expect(status.estimate).toBeUndefined();
    expect(status.phaseEstimate?.lowerMs).toBeGreaterThan(0);
    expect(status.phases.history.committed).toBe(30);
    tracker.pause('disk-pressure');
    now += 100000;
    expect(tracker.snapshot().phaseEstimate).toBeUndefined();
    const restored = new ProgressTracker({
      cutoff: new Date('2026-02-01'),
      clock: () => now,
      restored: tracker.checkpoint(),
    });
    restored.resume();
    expect(restored.snapshot().cutoff).toBe('2026-01-01T00:00:00.000Z');
    expect(restored.snapshot().phaseEstimate).toBeUndefined();
  });
  it('requires acknowledged verification to finish and bounds sample storage', () => {
    const now = 0;
    const tracker = new ProgressTracker({ cutoff: new Date(), clock: () => now });
    expect(() => tracker.finish('complete')).toThrow('work-incomplete');
    for (const phase of ['discovery', 'history', 'reactions', 'verification'] as const)
      tracker.setTotal(phase, 0);
    tracker.finish('complete');
    expect(tracker.snapshot().state).toBe('complete');
  });
  it.each(['discovery', 'reactions'] as const)(
    'rejects a %s denominator below acknowledged work without changing progress',
    (phase) => {
      const tracker = new ProgressTracker({ cutoff: new Date('2026-01-01') });
      tracker.setTotal(phase, 2);
      tracker.commit(phase, 2, 'acknowledged', 0);
      const before = tracker.checkpoint().phases[phase];
      expect(() => tracker.setTotal(phase, 0)).toThrow('invalid-progress-total');
      expect(tracker.checkpoint().phases[phase]).toEqual(before);
    },
  );
  it('includes all IDs at cutoff millisecond but excludes later new traffic', () => {
    const cutoff = new Date('2026-01-01');
    const before = BigInt(historyBefore(cutoff));
    expect(inHistoryScope((before - 1n).toString(), cutoff)).toBe(true);
    expect(inHistoryScope(before.toString(), cutoff)).toBe(false);
  });
  it('supports ten-second notification updates without sending early', async () => {
    let now = 0;
    const send = vi.fn(async () => undefined);
    const notifier = new ProgressNotifier(send, 10000, () => now);
    await notifier.update('start');
    now = 9999;
    await notifier.update('pending');
    expect(send).toHaveBeenCalledTimes(1);
    now = 10000;
    await notifier.update('latest');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith('latest');
  });
  it('coalesces notifications and isolates errors', async () => {
    let now = 0;
    const send = vi.fn(async () => {
      throw new Error('Discord down');
    });
    const notifier = new ProgressNotifier(send, 10000, () => now);
    await notifier.update('first');
    await notifier.update('second');
    expect(send).toHaveBeenCalledTimes(1);
    now = 10000;
    await notifier.update('third');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith('third');
    await notifier.update('done', true);
    await notifier.drain();
    expect(send).toHaveBeenCalledTimes(3);
    await notifier.stop();
  });
});

describe('complete reaction membership staging', () => {
  it('pages normal/burst independently with 100 users and no user profile reads', async () => {
    const get = vi.fn(async (_route, options) => {
      const after = options.query.get('after');
      const kind = options.query.get('type');
      return kind === '0' && after === null
        ? Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1) }))
        : kind === '0'
          ? [{ id: '101' }]
          : [{ id: '200' }];
    });
    const stage = vi.fn(async () => undefined);
    const results = await fetchReactionMemberships({
      rest: { get } as any,
      channelId: '1',
      messageId: '2',
      streams: [{ emoji: 'custom:3', kinds: ['normal', 'burst'] }],
      stage,
      isCurrent: () => true,
    });
    expect(results.map((result) => [result.kind, result.users, result.complete])).toEqual([
      ['normal', 101, true],
      ['burst', 1, true],
    ]);
    expect(stage.mock.calls.map((call: any) => call[0].userIds.length)).toEqual([100, 1, 1]);
    expect(get).toHaveBeenCalledTimes(3);
    expect(get.mock.calls[1]?.[1].query.get('after')).toBe('100');
  });
  it('does not publish stable completion when reactions changed during staging', async () => {
    let dirty = 0;
    const results = await fetchReactionMemberships({
      rest: { get: vi.fn(async () => [{ id: '1' }]) } as any,
      channelId: '1',
      messageId: '2',
      streams: [{ emoji: 'x', kinds: ['normal'] }],
      stage: async () => {
        dirty++;
      },
      isCurrent: () => dirty === 0,
    });
    expect(results[0]?.complete).toBe(false);
    expect(results[0]?.reason).toContain('changed-during-fetch');
  });
  it('keeps the thrown error of an incomplete stream and stops a stale fetch before reading', async () => {
    const denied = Object.assign(new Error('Missing Access'), { code: 50001, status: 403 });
    const get = vi.fn(async () => {
      throw denied;
    });
    const results = await fetchReactionMemberships({
      rest: { get } as any,
      channelId: '1',
      messageId: '2',
      streams: [{ emoji: 'x', kinds: ['normal'] }],
      stage: async () => undefined,
      isCurrent: () => true,
    });
    expect(results[0]).toMatchObject({ complete: false, error: denied });
    const stale = vi.fn(async () => [{ id: '1' }]);
    const aborted = await fetchReactionMemberships({
      rest: { get: stale } as any,
      channelId: '1',
      messageId: '2',
      streams: [{ emoji: 'x', kinds: ['normal'] }],
      stage: async () => undefined,
      isCurrent: () => false,
    });
    expect(aborted[0]).toMatchObject({ complete: false, reason: 'reaction-changed-during-fetch' });
    expect(stale).not.toHaveBeenCalled();
  });
  it('reports stalled pages as partial, keeps earlier staged work and still reads another kind', async () => {
    const users = Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1) }));
    const get = vi.fn(async (_route, options) => (options.query.get('type') === '0' ? users : []));
    const stage = vi.fn(async () => undefined);
    const results = await fetchReactionMemberships({
      rest: { get } as any,
      channelId: '1',
      messageId: '2',
      streams: [{ emoji: 'x', kinds: ['normal', 'burst'] }],
      stage,
      isCurrent: () => true,
    });
    expect(results[0]?.complete).toBe(false);
    expect(results[1]?.complete).toBe(true);
    expect(stage).toHaveBeenCalledTimes(1);
  });
});

it('REST discovery passes the correct timestamp versus ID cursor to the same manager', async () => {
  const get = vi.fn(async (_route: string, _options?: unknown) => ({
    threads: [],
    has_more: false,
  }));
  const api = restDiscoveryAdapter({ get } as any, '1');
  await api.archived('2', 'private', '2026-01-01T00:00:00Z');
  await api.archived('2', 'joined-private', '123');
  expect(get.mock.calls[0]?.[0]).toBe('/channels/2/threads/archived/private');
  expect((get.mock.calls[1] as any)[1].query.get('before')).toBe('123');
});

it('uses recurring work priors without guessing new channel totals', () => {
  const prior = updatePeriodicHistory(undefined, {
    cutoff: 10000,
    windowMs: 10000,
    scanned: 100,
    elapsedMs: 5000,
  });
  const priors = new Map([['known', prior]]);
  expect(estimatePeriodicWork(['known'], priors, 20000).total).toBe(100);
  expect(estimatePeriodicWork(['known', 'new'], priors, 20000).total).toBeUndefined();
  expect(estimatePeriodicWork(['known'], priors, 100000).reason).toBe('long-outage');
});

it('retains subsecond commits in wall-clock throughput samples', () => {
  let now = 0;
  const tracker = new ProgressTracker({ cutoff: new Date(), clock: () => now });
  tracker.setPhase('history');
  tracker.setTotal('history', 1000);
  for (let page = 0; page < 15; page++) {
    now += 200;
    tracker.commit('history', 10, 'channel', page);
  }
  expect(tracker.snapshot().phaseEstimate).toBeDefined();
  expect(tracker.snapshot().phases.history.rates).toHaveLength(3);
});

it('shows only a current known reaction phase ETA while whole history remains unknown', () => {
  let now = 0;
  const tracker = new ProgressTracker({ cutoff: new Date(), clock: () => now });
  tracker.setPhase('history');
  const estimator = new KnownPhaseEstimator('reactions', 1000, () => now);
  for (let page = 0; page < 3; page++) {
    now += 1000;
    estimator.commit(100);
  }
  tracker.setCurrentPhaseEstimate(estimator.snapshot());
  expect(tracker.snapshot().estimate).toBeUndefined();
  expect(tracker.snapshot().phaseEstimate?.phase).toBe('reactions');
  expect(tracker.snapshot().phaseEstimate?.reason).toBe('currently-known-work-only');
  tracker.pause('disk');
  expect(tracker.snapshot().phaseEstimate).toBeUndefined();
});
