import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ArchiveInboxLoop,
  type ArchiveInboxRound,
} from '../../../src/plugins/message-backup/runtime/inbox-loop';

const IDLE_MS = 5000;

/**
 * A loop whose rounds follow `script` (a result or an error per call, then idle
 * rounds), recording when each round started.
 */
const loop = (script: (ArchiveInboxRound | Error)[], retryBaseMs?: number) => {
  const controller = new AbortController();
  const starts: number[] = [];
  const failures: number[] = [];
  const round = vi.fn(async () => {
    starts.push(Date.now());
    const next = script.shift() ?? { retired: 0, joined: false };
    if (next instanceof Error) throw next;
    return next;
  });
  const inbox = new ArchiveInboxLoop({
    round,
    roundSize: 100,
    idleMs: IDLE_MS,
    signal: controller.signal,
    onFailure: (_error, count) => failures.push(count),
    ...(retryBaseMs === undefined ? {} : { retryBaseMs }),
  });
  const run = inbox.run();
  return { inbox, run, round, starts, failures, stop: () => controller.abort() };
};
const idle: ArchiveInboxRound = { retired: 0, joined: false };

describe('archive inbox loop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it('backs off failed rounds from one second to a one-minute cap and resets after success', async () => {
    const failure = new Error('database unavailable');
    const f = loop([...Array.from({ length: 8 }, () => failure), idle, failure, idle]);
    await vi.advanceTimersByTimeAsync(130_000 + 60_000 + IDLE_MS + 1000);
    // 1, 2, 4, 8, 16, 32 seconds, then the 60-second cap twice.
    expect(f.starts.slice(0, 9)).toEqual([
      0, 1000, 3000, 7000, 15_000, 31_000, 63_000, 123_000, 183_000,
    ]);
    expect(f.failures).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 1]);
    // After the success the loop idles, then the next failure waits one second again.
    expect(f.starts[9]).toBe(183_000 + IDLE_MS);
    expect(f.starts[10]).toBe(183_000 + IDLE_MS + 1000);
    f.stop();
    await f.run;
  });

  it('doubles a configured first retry wait', async () => {
    const failure = new Error('database unavailable');
    const f = loop([failure, failure, failure, idle], 10);
    await vi.advanceTimersByTimeAsync(70);
    expect(f.starts).toEqual([0, 10, 30, 70]);
    f.stop();
    await f.run;
  });

  it('runs the next round at once while events remain, after a joined round or a capture', async () => {
    const f = loop([{ retired: 100, joined: false }, { retired: 1, joined: true }, idle]);
    await vi.advanceTimersByTimeAsync(0);
    // A full round (101 pending) and a joined round are followed at once.
    expect(f.starts).toEqual([0, 0, 0]);
    f.inbox.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.starts).toEqual([0, 0, 0, 0]);
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(f.starts).toEqual([0, 0, 0, 0, IDLE_MS]);
    f.stop();
    await f.run;
  });

  it('runs again at once for a capture made during a round', async () => {
    let release!: (round: ArchiveInboxRound) => void;
    const f = loop([]);
    f.round.mockImplementationOnce(
      () =>
        new Promise<ArchiveInboxRound>((resolve) => {
          release = resolve;
        }),
    );
    // The first round already started with the empty script; block the next one.
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    f.inbox.wake();
    release(idle);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.round).toHaveBeenCalledTimes(3);
    f.stop();
    await f.run;
  });

  it('stops at its next wait', async () => {
    const f = loop([]);
    await vi.advanceTimersByTimeAsync(0);
    f.stop();
    await f.run;
    await vi.advanceTimersByTimeAsync(IDLE_MS * 3);
    expect(f.round).toHaveBeenCalledTimes(1);
  });
});
