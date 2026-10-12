import { describe, expect, it, vi } from 'vitest';
import {
  archiveJobProgress,
  sanitizeArchiveProgress,
  type ArchiveProgressSnapshot,
} from '../../../../src/core/archive/progress';
import type { ArchiveFullBackupJob } from '../../../../src/core/archive/types';
import {
  ProgressNotifier,
  ProgressTracker,
} from '../../../../src/plugins/message-backup/flow/progress';

const tracker = () =>
  new ProgressTracker({
    cutoff: new Date(1000),
    startedAt: 1000,
    work: 'full-backup',
    jobId: '1:job',
    runId: 'run',
    clock: () => 6000,
  });

describe('truthful bounded archive progress', () => {
  it('measures only fresh checkpoints and keeps restored totals independent of this job time', () => {
    let now = 100000;
    const progress = new ProgressTracker({
      cutoff: new Date(now),
      startedAt: now,
      clock: () => now,
    });
    progress.commit('history', 500000, 'source', 9, true, 50000);
    progress.messageCounts({ scanned: 500000, updated: 200000 });
    expect(progress.snapshot()).toMatchObject({ lastCheckpointAt: 50000, elapsedMs: 0 });
    expect(progress.snapshot().recentThroughput).toBeUndefined();
    now += 1000;
    progress.commit('history', 100, 'source', 10);
    expect(progress.snapshot().recentThroughput).toBeUndefined();
    now += 2000;
    progress.commit('history', 100, 'source', 11);
    expect(progress.snapshot().recentThroughput).toEqual({
      messages: 100,
      windowMs: 2000,
      observedAt: now,
    });
    expect(progress.snapshot().phases.history.committed).toBe(500200);
    expect(progress.snapshot().elapsedMs).toBe(3000);
    expect(progress.commit('history', 100, 'source', 11)).toBe(false);
    expect(progress.snapshot().recentThroughput?.messages).toBe(100);
    now += 30001;
    expect(progress.snapshot().recentThroughput).toBeUndefined();
    progress.pause('maintenance');
    progress.resume();
    now += 1000;
    progress.commit('history', 100, 'source', 12);
    expect(progress.snapshot().recentThroughput).toBeUndefined();
  });
  it('keeps only known message counters and rejects invalid recent speed evidence', () => {
    const saved = sanitizeArchiveProgress({
      phase: 'history',
      state: 'running',
      messages: { updated: 10, upgraded: 3 },
    })!;
    expect(saved.messages.updated).toBe(10);
    expect(saved.messages).not.toHaveProperty('upgraded');
    for (const windowMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(
        sanitizeArchiveProgress({
          phase: 'history',
          state: 'running',
          recentThroughput: { messages: 10, windowMs, observedAt: 1000 },
        })?.recentThroughput,
      ).toBeUndefined();
    const fresh = tracker();
    fresh.messageCounts({ inserted: 7 });
    expect(fresh.snapshot().messages).toMatchObject({ inserted: 7, updated: 0 });
  });
  it('selects recent active work without changing stable source pagination', () => {
    let now = 1000;
    const progress = new ProgressTracker({
      cutoff: new Date(1000),
      startedAt: 1000,
      work: 'full-backup',
      clock: () => now,
    });
    progress.activity('10', { step: 'writing' });
    now = 2000;
    progress.activity('11', { step: 'writing' });
    now = 3000;
    progress.activity('12', { step: 'waiting', waitSince: now, retryAt: 9000 });
    expect(progress.snapshot().activities.map((item) => item.sourceId)).toEqual(['11', '10', '12']);
    now = 4000;
    progress.activity('10', { pageProcessed: 25, pageTotal: 100 });
    expect(progress.snapshot().activities[0]).toMatchObject({
      sourceId: '10',
      startedAt: 1000,
      updatedAt: 4000,
    });
    expect(progress.activityDetails().map((item) => item.sourceId)).toEqual(['10', '11', '12']);
  });

  it('clears stale wait, page and membership details as the source resumes fetching', () => {
    const progress = tracker();
    progress.activity('10', {
      step: 'reactions',
      pageProcessed: 2,
      pageTotal: 100,
      reactionUsers: 100,
      reactionPages: 1,
      provisional: true,
    });
    progress.activity('10', { step: 'waiting', waitSince: 5000, retryAt: 9000 });
    expect(progress.snapshot().activities[0]).toMatchObject({
      reactionUsers: 100,
      reactionPages: 1,
    });
    progress.activity('10', { step: 'reactions', reactionUsers: 101, reactionPages: 2 });
    expect(progress.snapshot().activities[0]?.waitSince).toBeUndefined();
    expect(progress.snapshot().activities[0]?.retryAt).toBeUndefined();
    progress.activity('10', { step: 'fetching' });
    const activity = progress.snapshot().activities[0]!;
    for (const key of [
      'pageProcessed',
      'pageTotal',
      'reactionUsers',
      'reactionPages',
      'provisional',
    ] as const)
      expect(activity[key]).toBeUndefined();
  });

  it('omits invalid optional activity counts instead of displaying invented zeroes', () => {
    const progress = tracker();
    progress.activity('10', { step: 'reactions' });
    const snapshot = progress.snapshot();
    snapshot.activities[0] = {
      ...snapshot.activities[0]!,
      pageProcessed: NaN,
      pageTotal: Infinity,
      reactionUsers: -1,
      reactionPages: NaN,
    };
    const activity = sanitizeArchiveProgress(snapshot)!.activities[0]!;
    for (const key of ['pageProcessed', 'pageTotal', 'reactionUsers', 'reactionPages'] as const)
      expect(activity[key]).toBeUndefined();
  });

  it('evicts the stalest activity at the bound and logs it instead of failing the source', () => {
    let now = 6000;
    const warn = vi.fn();
    const progress = new ProgressTracker({
      cutoff: new Date(1000),
      startedAt: 1000,
      work: 'full-backup',
      jobId: '1:job',
      runId: 'run',
      clock: () => now,
      logger: { warn },
    });
    for (let i = 0; i < 64; i += 1) {
      now = 6000 + i;
      progress.activity(String(i), { step: i === 30 ? 'waiting' : 'processing' });
    }
    // A running source refreshes its entry; it stays newest.
    progress.activity('0', { step: 'fetching' });
    expect(() => progress.activity('64', { step: 'processing' })).not.toThrow();
    expect(() => progress.activity('65', { step: 'processing' })).not.toThrow();
    const ids = progress.activityDetails().map((activity) => activity.sourceId);
    expect(ids).toHaveLength(64);
    // The waiting entry goes first, then the least recently updated one.
    expect(ids).not.toContain('30');
    expect(ids).not.toContain('1');
    expect(ids).toEqual(expect.arrayContaining(['0', '2', '64', '65']));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      bound: 64,
      evictedSourceId: '30',
      evictedActivities: 1,
    });
  });

  it('clears the activity of a source reported again after it completed', () => {
    const progress = tracker();
    progress.activity('10', { step: 'processing' });
    progress.completeSource('10');
    progress.activity('10', { step: 'reactions' });
    progress.completeSource('10');
    expect(progress.snapshot()).toMatchObject({
      activityCount: 0,
      sources: { completed: 1 },
    });
  });
});

describe('full-backup job progress', () => {
  const job = (overrides: Partial<ArchiveFullBackupJob> = {}): ArchiveFullBackupJob => ({
    jobId: '1:backup',
    requestId: 'backup',
    guildId: '1',
    command: 'full-backup',
    options: { cutoff: 5000 },
    runId: 'full:backup',
    status: 'queued',
    cancelRequested: false,
    createdAt: 1000,
    ...overrides,
  });

  it('starts from the fixed cutoff before the first saved snapshot', () => {
    const progress = archiveJobProgress(job(), 2000);
    expect(progress).toMatchObject({
      work: 'full-backup',
      state: 'queued',
      cutoff: new Date(5000).toISOString(),
      cutoffKnown: true,
      runId: 'full:backup',
    });
  });

  it('reports a stop request on a running job and clears live activity once finished', () => {
    const tracked = tracker();
    tracked.activity('10', { step: 'fetching', name: 'room' });
    const result = { progress: tracked.snapshot() };
    expect(
      archiveJobProgress(job({ status: 'running', cancelRequested: true, result })).state,
    ).toBe('cancelling');
    expect(
      archiveJobProgress(job({ status: 'cancelled', finishedAt: 7000, result })),
    ).toMatchObject({ state: 'cancelled', activities: [], activityCount: 0 });
  });

  it('keeps messages left with stale reactions through sanitization', () => {
    const tracked = tracker();
    tracked.reactionStale(2);
    tracked.reactionCompleted(5);
    expect(sanitizeArchiveProgress(tracked.snapshot())?.reactions).toEqual({
      required: 0,
      completed: 5,
      stale: 2,
    });
    expect(
      sanitizeArchiveProgress({ ...tracked.snapshot(), reactions: { required: 1, completed: 1 } })
        ?.reactions,
    ).toEqual({ required: 1, completed: 1 });
  });
});

describe('decoupled progress publication', () => {
  it('keeps one pending latest value during a slow sender and drains the newest generation', async () => {
    let release!: () => void;
    const block = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: number[] = [];
    const notifier = new ProgressNotifier<number>(async (value) => {
      sent.push(value);
      if (value === 0) await block;
    }, 10000);
    await notifier.update(0, true);
    for (let i = 1; i <= 1000; i += 1) await notifier.update(i, true);
    expect(notifier.snapshot()).toMatchObject({ pending: 1, sending: true });
    release();
    await notifier.drain();
    expect(sent).toEqual([0, 1000]);
    await notifier.stop();
    await notifier.update(1001, true);
    expect(sent).toEqual([0, 1000]);
  });

  it('retries a failed sender after five seconds with the latest snapshot', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async (value: number) => {
      if (value === 1) throw new Error('delivery unavailable');
    });
    const notifier = new ProgressNotifier(send, 10000);
    try {
      await notifier.update(1, true);
      await Promise.resolve();
      await Promise.resolve();
      await notifier.update(2, true);
      await vi.advanceTimersByTimeAsync(4999);
      expect(send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await notifier.drain();
      expect(send.mock.calls.map(([value]) => value)).toEqual([1, 2]);
    } finally {
      await notifier.stop();
      vi.useRealTimers();
    }
  });

  it('reads every stored snapshot version and rejects unknown ones', () => {
    const estimate = { lowerMs: 10, upperMs: 20, scope: 'run', reason: 'observed-throughput' };
    const base = { phase: 'history', state: 'running', elapsedMs: 50, estimatedAt: 7 };
    expect(sanitizeArchiveProgress({ ...base, version: 3 })).toBeUndefined();
    const legacy = sanitizeArchiveProgress({ ...base, version: 1, phaseEstimate: estimate });
    expect(legacy).toMatchObject({
      version: 2,
      activeMs: 50,
      updatedAt: 7,
      lastProgressAt: 7,
      estimate: { lowerMs: 10, upperMs: 20, scope: 'run', confidence: 'low' },
    });
    expect(
      sanitizeArchiveProgress({ ...base, version: 2, phaseEstimate: estimate })?.estimate,
    ).toBeUndefined();
    expect(sanitizeArchiveProgress({ ...base, phase: 'repair' })?.phase).toBe('history');
    expect(sanitizeArchiveProgress({ ...base, state: 'unknown' })).toBeUndefined();
  });

  describe('stored snapshot fallbacks', () => {
    const base = { phase: 'history', state: 'running' };
    const read = (fields: Record<string, unknown>, includeRates = false) =>
      sanitizeArchiveProgress({ ...base, ...fields }, { includeRates })!;
    const activity = (fields: Record<string, unknown>) => ({
      sourceId: '10',
      step: 'fetching',
      ...fields,
    });

    it.each<
      [string, Record<string, unknown>, (snapshot: ArchiveProgressSnapshot) => unknown, unknown]
    >([
      [
        'replaces control characters in names and bounds them',
        { activities: [activity({ name: `a\u0001b${'x'.repeat(120)}` })] },
        (snapshot) => snapshot.activities[0]?.name,
        `a b${'x'.repeat(97)}`,
      ],
      [
        'drops an activity without a valid source ID',
        { activities: [activity({ sourceId: 'bad id!' }), activity({})] },
        (snapshot) => snapshot.activities.map((entry) => entry.sourceId),
        ['10'],
      ],
      [
        'omits an invalid gap source ID and reads an unknown reason as other',
        { gaps: [{ sourceId: 'bad id!', reason: 'mystery' }] },
        (snapshot) => snapshot.gaps,
        [{ reason: 'other' }],
      ],
      [
        'counts at least the listed gaps',
        { gaps: [{}, {}], gapCount: 1 },
        (snapshot) => [snapshot.gapCount, snapshot.gapCountKnown],
        [2, true],
      ],
      [
        'knows the gap count only from an exact count or a list',
        { gapCount: 2.5 },
        (snapshot) => [snapshot.gapCount, snapshot.gapCountKnown],
        [2.5, false],
      ],
      [
        'calls sources discovered only for an exact total',
        { sources: { completed: 1, total: 3.5 } },
        (snapshot) => snapshot.sources,
        { completed: 1, total: 3.5, quality: 'unknown' },
      ],
      [
        'keeps an explicitly unknown source total unknown',
        { sources: { completed: 1, total: 3, quality: 'unknown' } },
        (snapshot) => snapshot.sources.quality,
        'unknown',
      ],
      [
        'reads an invalid cutoff as unknown',
        { cutoff: 'not a date' },
        (snapshot) => [snapshot.cutoff, snapshot.cutoffKnown],
        [new Date(0).toISOString(), false],
      ],
      [
        'keeps a cutoff an older snapshot marked unknown unknown',
        { cutoff: '2026-01-01T00:00:00Z', cutoffKnown: false },
        (snapshot) => snapshot.cutoffKnown,
        false,
      ],
      [
        'drops an estimate whose upper bound is below its lower bound',
        { estimate: { lowerMs: 20, upperMs: 10, scope: 'run' } },
        (snapshot) => snapshot.estimate,
        undefined,
      ],
      [
        'reads a timestamp beyond the representable range as 0',
        { startedAt: 8_640_000_000_000_001 },
        (snapshot) => snapshot.startedAt,
        0,
      ],
      [
        'keeps lastCheckpointAt only when stored as a number',
        { lastCheckpointAt: Number.NaN },
        (snapshot) => snapshot.lastCheckpointAt,
        0,
      ],
      [
        'omits lastCheckpointAt stored as text',
        { lastCheckpointAt: '5' },
        (snapshot) => 'lastCheckpointAt' in snapshot,
        false,
      ],
      // Pinned since the schema rewrite: non-string values are no longer accepted
      // because their text form happens to name a valid value.
      [
        'reads a non-string work as periodic',
        { work: ['full-backup'] },
        (snapshot) => snapshot.work,
        'periodic',
      ],
      [
        'drops an estimate whose scope is not a string',
        { estimate: { lowerMs: 10, upperMs: 20, scope: ['run'] } },
        (snapshot) => snapshot.estimate,
        undefined,
      ],
    ])('%s', (_rule, fields, select, expected) => {
      expect(select(read(fields))).toEqual(expected);
    });

    it('keeps the last sixteen positive finite rates, and only when asked', () => {
      const rates = [1, -1, 0, Number.NaN, Number.POSITIVE_INFINITY, 'x', ...Array(20).fill(2), 3];
      expect(read({ phases: { history: { rates } } }).phases.history).not.toHaveProperty('rates');
      const kept = read({ phases: { history: { rates } } }, true).phases.history.rates;
      expect(kept).toHaveLength(16);
      expect(kept?.at(-1)).toBe(3);
      expect(kept?.every((rate) => rate === 2 || rate === 3)).toBe(true);
    });
  });
});
