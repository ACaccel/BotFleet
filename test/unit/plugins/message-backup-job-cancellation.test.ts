import { describe, expect, it, vi } from 'vitest';
import {
  ArchiveJobCancellation,
  ArchiveJobStoppedError,
} from '../../../src/plugins/message-backup/runtime/job-cancellation';

describe('job stop checkpoints', () => {
  it('bounds lookup count by elapsed time during a 100k document scan', async () => {
    let now = 0;
    const lookup = vi.fn().mockResolvedValue(false);
    const cancellation = new ArchiveJobCancellation('job-a', lookup, undefined, () => now);
    for (let document = 0; document < 100_000; document += 1) await cancellation.checkpoint();
    expect(lookup).toHaveBeenCalledTimes(1);
    now = 249;
    await cancellation.checkpoint();
    expect(lookup).toHaveBeenCalledTimes(1);
    now = 250;
    await cancellation.checkpoint();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent lookups and measures freshness from query issue time', async () => {
    let now = 0;
    let resolve!: (value: boolean) => void;
    const lookup = vi.fn().mockImplementation(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    const cancellation = new ArchiveJobCancellation('job-a', lookup, undefined, () => now);
    const first = cancellation.checkpoint();
    const second = cancellation.checkpoint();
    await Promise.resolve();
    expect(lookup).toHaveBeenCalledTimes(1);
    now = 300;
    resolve(false);
    await Promise.all([first, second]);
    const next = cancellation.checkpoint();
    await Promise.resolve();
    expect(lookup).toHaveBeenCalledTimes(2);
    resolve(false);
    await next;
  });

  it('isolates jobs and fresh executions and latches observed cancellation', async () => {
    const lookup = vi.fn(async (jobId: string) => jobId === 'job-a');
    const first = new ArchiveJobCancellation('job-a', lookup);
    const other = new ArchiveJobCancellation('job-b', lookup);
    await expect(first.checkpoint()).rejects.toBeInstanceOf(ArchiveJobStoppedError);
    await expect(other.checkpoint()).resolves.toBeUndefined();
    await expect(first.checkpoint()).rejects.toBeInstanceOf(ArchiveJobStoppedError);
    expect(first.isCancelled()).toBe(true);
    expect(other.isCancelled()).toBe(false);
    expect(lookup).toHaveBeenCalledTimes(2);
    const fresh = new ArchiveJobCancellation('job-b', lookup);
    await fresh.checkpoint();
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('stops immediately on local abort while a database lookup is pending', async () => {
    const controller = new AbortController();
    let reject!: (reason: Error) => void;
    const lookup = vi.fn(
      () =>
        new Promise<boolean>((_done, fail) => {
          reject = fail;
        }),
    );
    const cancellation = new ArchiveJobCancellation('job-a', lookup, controller.signal);
    const checkpoint = cancellation.checkpoint();
    controller.abort();
    await expect(checkpoint).rejects.toBeInstanceOf(ArchiveJobStoppedError);
    expect(cancellation.isCancelled()).toBe(true);
    reject(new Error('late database failure'));
    await Promise.resolve();
    await expect(cancellation.checkpoint()).rejects.toBeInstanceOf(ArchiveJobStoppedError);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('does not query after a prior local abort and retries failed lookups', async () => {
    const controller = new AbortController();
    controller.abort();
    const lookup = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(false);
    const stopped = new ArchiveJobCancellation('job-a', lookup, controller.signal);
    await expect(stopped.checkpoint()).rejects.toBeInstanceOf(ArchiveJobStoppedError);
    expect(lookup).not.toHaveBeenCalled();
    const cancellation = new ArchiveJobCancellation('job-a', lookup);
    await expect(cancellation.checkpoint()).rejects.toThrow('unavailable');
    await expect(cancellation.checkpoint()).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('refreshes when an injected clock moves backwards', async () => {
    let now = 1000;
    const lookup = vi.fn().mockResolvedValue(false);
    const cancellation = new ArchiveJobCancellation('job-a', lookup, undefined, () => now);
    await cancellation.checkpoint();
    now = 500;
    await cancellation.checkpoint();
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
