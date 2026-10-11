import { describe, expect, it, vi } from 'vitest';

import {
  ArchiveScheduler,
  mapArchiveChannels,
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
describe('REST admission scheduler', () => {
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
  it.each([4999, 5000, 9999, 10001, 30000, NaN, Infinity])(
    'rejects invalid notification cadence %s',
    (interval) => {
      expect(() => new ProgressNotifier(async () => undefined, interval)).toThrow();
    },
  );
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
