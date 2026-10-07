import { describe, expect, it, vi } from 'vitest';

import { ArchivePipelineBudget } from '../../../src/plugins/message-backup/flow/pipeline';
import { ArchiveScheduler } from '../../../src/plugins/message-backup/flow/scheduler';
import { fetchReactionMemberships } from '../../../src/plugins/message-backup/flow/reactions';
import { discoverGuild } from '../../../src/plugins/message-backup/flow/discovery';
import { runArchivePipelineProbe } from '../../helpers/archive-pipeline-probe';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

describe('owner-wide pipeline resource envelope', () => {
  it('keeps a reaction lane available under full history pressure and wakes bounded waiters', async () => {
    const budget = new ArchivePipelineBudget(8);
    const current = await budget.reserve(7);
    const speculative = budget.reserve(3);
    expect(budget.snapshot().waiting).toBe(1);
    const reaction = await budget.reserve(1, undefined, 'reactions');
    expect(budget.snapshot().reservedBytes).toBe(8);
    expect(budget.snapshot().peakReservedBytes).toBe(8);
    reaction();
    current();
    (await speculative)();
    current();
    expect(budget.snapshot().reservedBytes).toBe(0);
  });

  it('reclaims confirmed unused capacity while preserving lane accounting and release ownership', async () => {
    const budget = new ArchivePipelineBudget(16);
    const release = await budget.reserve(14);
    const queued = budget.reserve(10);
    release.shrink(4);
    const successor = await queued;
    expect(budget.snapshot().waiting).toBe(0);
    expect(budget.snapshot().reservedBytes).toBe(14);
    expect(() => release.shrink(5)).toThrow('invalid-archive-pipeline-shrink');
    expect(() => release.shrink(0)).toThrow('invalid-archive-pipeline-shrink');
    release();
    release();
    expect(budget.snapshot().reservedBytes).toBe(10);
    expect(() => release.shrink(1)).toThrow('reservation-released');
    successor();
    expect(budget.snapshot().reservedBytes).toBe(0);
  });

  it('cancels a byte waiter without leaking bytes or blocking its successor', async () => {
    const budget = new ArchivePipelineBudget(8);
    const release = await budget.reserve(7);
    const controller = new AbortController();
    const cancelled = budget.reserve(3, controller.signal);
    const successor = budget.reserve(2);
    controller.abort();
    await expect(cancelled).rejects.toThrow('cancelled');
    expect(budget.snapshot().waiting).toBe(1);
    release();
    (await successor)();
    expect(budget.snapshot().reservedBytes).toBe(0);
    await expect(budget.reserve(8)).rejects.toThrow('too-large');
  });
});

describe('shared SDK readiness fallback', () => {
  it('coalesces each cancellation authority independently and keeps distinct generations separate', async () => {
    const scheduler = new ArchiveScheduler({ concurrency: 1 });
    scheduler.pauseBackground();
    const firstSignal = new AbortController();
    const secondSignal = new AbortController();
    const read = vi.fn(async () => 1);
    const first = scheduler.run('same-key', 'history', read, {
      signal: firstSignal.signal,
      generation: 'one',
    });
    const second = scheduler.run('same-key', 'history', read, {
      signal: secondSignal.signal,
      generation: 'one',
    });
    expect(
      scheduler.run('same-key', 'history', read, {
        signal: secondSignal.signal,
        generation: 'one',
      }),
    ).toBe(second);
    const newGeneration = scheduler.run('same-key', 'history', read, {
      signal: secondSignal.signal,
      generation: 'two',
    });
    expect(newGeneration).not.toBe(second);
    firstSignal.abort();
    await expect(first).rejects.toThrow('cancelled');
    scheduler.resumeBackground();
    await Promise.all([second, newGeneration]);
    expect(read).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });
  it('lets ready resources advance while another resource occupies an announced local wait', async () => {
    const scheduler = new ArchiveScheduler({ concurrency: 1 });
    const blocked = deferred<number>();
    const first = scheduler.run('history:10:page', 'history', () => blocked.promise, {
      guildId: 'one',
    });
    await Promise.resolve();
    scheduler.observeWait({
      resourceId: '10',
      bucketKey: 'hash-major10',
      global: false,
      deadlineAt: Date.now() + 1000,
    });
    expect(
      await scheduler.run('history:20:page', 'history', async () => 2, { guildId: 'two' }),
    ).toBe(2);
    expect(scheduler.snapshot().waitingResources).toBe(1);
    blocked.resolve(1);
    expect(await first).toBe(1);
    scheduler.stop();
  });

  it('uses guild rotation and a reserved live slot while preserving one request per channel', async () => {
    const scheduler = new ArchiveScheduler({ concurrency: 1 });
    const blocked = deferred<number>();
    const started: string[] = [];
    const first = scheduler.run('history:10:one', 'history', () => blocked.promise, {
      guildId: 'one',
    });
    const sameChannel = scheduler.run(
      'reaction:10:two',
      'enrichment',
      async () => {
        started.push('same');
        return 1;
      },
      { guildId: 'one' },
    );
    const sameGuild = scheduler.run(
      'history:11:two',
      'history',
      async () => {
        started.push('one');
        return 2;
      },
      { guildId: 'one' },
    );
    const anotherGuild = scheduler.run(
      'history:20:two',
      'history',
      async () => {
        started.push('two');
        return 3;
      },
      { guildId: 'two' },
    );
    expect(await scheduler.run('notify:debug', 'live', async () => 4)).toBe(4);
    expect(started).toEqual([]);
    blocked.resolve(1);
    await first;
    await Promise.all([sameChannel, sameGuild, anotherGuild]);
    expect(started.indexOf('two')).toBeLessThan(started.indexOf('one'));
    scheduler.stop();
  });

  it('defers all token work during global wait and never rearms a stopped owner timer', async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new ArchiveScheduler({ concurrency: 1 });
      scheduler.observeWait({
        resourceId: 'global',
        bucketKey: 'global',
        global: true,
        deadlineAt: Date.now() + 1000,
      });
      const work = vi.fn(async () => 1);
      const queued = scheduler.run('notify:debug', 'live', work);
      expect(work).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(999);
      expect(work).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await queued).toBe(1);
      scheduler.observeWait({
        resourceId: 'global',
        bucketKey: 'global',
        global: true,
        deadlineAt: Date.now() + 10000,
      });
      scheduler.stop();
      scheduler.observeWait({
        resourceId: 'global',
        bucketKey: 'global',
        global: true,
        deadlineAt: Date.now() + 100000,
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('independent sequential membership streams', () => {
  it('fetches another kind while durable staging of its predecessor is slow', async () => {
    const stageGate = deferred<void>();
    const kinds: string[] = [];
    const get = vi.fn(async (_route: string, options: { query: URLSearchParams }) => {
      kinds.push(options.query.get('type')!);
      return options.query.get('type') !== '0'
        ? [{ id: '200' }]
        : options.query.has('after')
          ? [{ id: '101' }]
          : Array.from({ length: 100 }, (_, index) => ({ id: String(index + 1) }));
    });
    const pending = fetchReactionMemberships({
      rest: { get } as never,
      channelId: '10',
      messageId: '100',
      concurrency: 2,
      streams: [{ emoji: 'x', kinds: ['normal', 'burst'] }],
      dirtyVersion: () => 0,
      stage: async ({ kind }) => {
        if (kind === 'normal') await stageGate.promise;
      },
    });
    await vi.waitFor(() => expect(kinds).toEqual(['0', '1']));
    stageGate.resolve();
    expect((await pending).every((stream) => stream.complete)).toBe(true);
    expect(kinds).toEqual(['0', '1', '0']);
  });

  it('returns discarded profile capacity so more membership streams fetch during slow staging', async () => {
    const gate = deferred<void>();
    const budget = new ArchivePipelineBudget();
    const get = vi.fn(async () => [{ id: '200', profile: 'x'.repeat(1024) }]);
    const pending = fetchReactionMemberships({
      rest: { get } as never,
      channelId: '10',
      messageId: '100',
      concurrency: 3,
      streams: ['a', 'b', 'c'].map((emoji) => ({ emoji, kinds: ['normal'] })),
      dirtyVersion: () => 0,
      stage: async () => gate.promise,
      pipelineBudget: budget,
    });
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    expect(budget.snapshot().reservedBytes).toBeLessThan(1024);
    gate.resolve();
    expect((await pending).every((stream) => stream.complete)).toBe(true);
    expect(budget.snapshot().reservedBytes).toBe(0);
  });

  it('uses only fresh guarded empty evidence and keeps failures partial', async () => {
    const get = vi.fn(async () => []);
    const stage = vi.fn(async () => undefined);
    const results = await fetchReactionMemberships({
      rest: { get } as never,
      channelId: '10',
      messageId: '100',
      streams: [{ emoji: 'x', kinds: ['normal', 'burst'], emptyKinds: ['normal'] }],
      dirtyVersion: () => 0,
      stage,
      concurrency: 2,
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      { emoji: 'x', kind: 'normal', users: 0, complete: true },
      { emoji: 'x', kind: 'burst', users: 0, complete: true },
    ]);
    expect(stage).not.toHaveBeenCalled();
    get.mockRejectedValueOnce(new Error('403'));
    expect(
      (
        await fetchReactionMemberships({
          rest: { get } as never,
          channelId: '10',
          messageId: '100',
          streams: [{ emoji: 'x', kinds: ['normal'] }],
          dirtyVersion: () => 0,
          stage,
        })
      )[0]?.complete,
    ).toBe(false);
  });

  it('releases oversized reaction responses without staging or complete publication', async () => {
    const budget = new ArchivePipelineBudget();
    const stage = vi.fn(async () => undefined);
    const result = await fetchReactionMemberships({
      rest: { get: async () => [{ id: '1', metadata: 'x'.repeat(4 * 1024 * 1024) }] } as never,
      channelId: '10',
      messageId: '100',
      streams: [{ emoji: 'x', kinds: ['normal'] }],
      stage,
      dirtyVersion: () => 0,
      pipelineBudget: budget,
    });
    expect(result[0]?.complete).toBe(false);
    expect(result[0]?.reason).toContain('too-large');
    expect(stage).not.toHaveBeenCalled();
    expect(budget.snapshot().reservedBytes).toBe(0);
  });

  it('invalidates an otherwise empty completed stream when another kind observes a dirty generation', async () => {
    let dirty = 0;
    const result = await fetchReactionMemberships({
      rest: { get: async () => [{ id: '1' }] } as never,
      channelId: '10',
      messageId: '100',
      concurrency: 2,
      streams: [{ emoji: 'x', kinds: ['normal', 'burst'], emptyKinds: ['normal'] }],
      stage: async () => {
        dirty += 1;
      },
      dirtyVersion: () => dirty,
    });
    expect(result.every((stream) => !stream.complete)).toBe(true);
    expect(result.every((stream) => stream.reason === 'reaction-changed-during-fetch')).toBe(true);
  });
});

it('explores independent thread parents concurrently and preserves private permission gaps', async () => {
  const first = deferred<{ locations: never[]; hasMore: boolean }>();
  const starts: string[] = [];
  const pending = discoverGuild(
    {
      channels: async () => [
        { id: '10', type: 0 },
        { id: '20', type: 0 },
      ],
      active: async () => [],
      archived: async (parent, pass) => {
        starts.push(`${parent}:${pass}`);
        if (parent === '10' && pass === 'public') return first.promise;
        if (parent === '20' && pass === 'private') throw new Error('403');
        return { locations: [], hasMore: false };
      },
    },
    { concurrency: 2 },
  );
  await vi.waitFor(() => expect(starts).toContain('20:joined-private'));
  expect(starts).toContain('10:public');
  first.resolve({ locations: [], hasMore: false });
  const result = await pending;
  expect(result.complete).toBe(false);
  expect(result.gaps).toContainEqual({ pass: 'private', channelId: '20', reason: 'Error: 403' });
});

it.each([2, 4, 8])(
  'keeps acknowledged results and quotas equivalent at concurrency %s',
  async (concurrency) => {
    const common = {
      concurrency,
      channels: 4,
      pages: 2,
      requestLatencyMs: 2,
      writeLatencyMs: 2,
      quotaIntervalMs: 2,
    };
    const sequential = await runArchivePipelineProbe({ ...common, prefetch: false });
    const pipelined = await runArchivePipelineProbe({ ...common, prefetch: true });
    expect(pipelined.messagesConfirmed).toBe(800);
    expect(pipelined.equivalenceDigest).toBe(sequential.equivalenceDigest);
    expect(pipelined.successfulRequests).toBe(sequential.successfulRequests);
    expect(pipelined.actual429).toBe(0);
    expect(pipelined.issues).toEqual([]);
    expect(pipelined.pipeline.reservedBytes).toBe(0);
    expect(pipelined.pipeline.peakReservedBytes).toBeLessThanOrEqual(
      pipelined.pipeline.capacityBytes,
    );
    expect(pipelined.completedSources).toBe(4);
  },
);
