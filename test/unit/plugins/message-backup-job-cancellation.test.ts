import { describe, expect, it, vi } from 'vitest';
import {
  ArchiveJobCancellation,
  ArchiveJobStoppedError,
} from '../../../src/plugins/message-backup/runtime/job-cancellation';

describe('job stop checkpoints', () => {
  it('bounds lookup count by elapsed time during a 100k document scan', async () => {
    let now = 0;
    const lookup = vi.fn().mockResolvedValue(false);
    const cancellation = new ArchiveJobCancellation('job-a', lookup, { now: () => now });
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
    const cancellation = new ArchiveJobCancellation('job-a', lookup, { now: () => now });
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
    const cancellation = new ArchiveJobCancellation('job-a', lookup, { signal: controller.signal });
    const checkpoint = cancellation.checkpoint();
    controller.abort();
    await expect(checkpoint).rejects.toBeInstanceOf(ArchiveJobStoppedError);
    expect(cancellation.isCancelled()).toBe(true);
    reject(new Error('late database failure'));
    await Promise.resolve();
    await expect(cancellation.checkpoint()).rejects.toBeInstanceOf(ArchiveJobStoppedError);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('does not query after a prior local abort', async () => {
    const controller = new AbortController();
    controller.abort();
    const lookup = vi.fn().mockResolvedValue(false);
    const stopped = new ArchiveJobCancellation('job-a', lookup, { signal: controller.signal });
    await expect(stopped.checkpoint()).rejects.toBeInstanceOf(ArchiveJobStoppedError);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('treats a failed lookup as not stopped for every waiter and asks again at the next boundary', async () => {
    let now = 0;
    let reject!: (reason: Error) => void;
    const lookup = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((_done, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValueOnce(true);
    const warn = vi.fn();
    const cancellation = new ArchiveJobCancellation('job-a', lookup, {
      now: () => now,
      logger: { warn },
    });
    const waiters = Array.from({ length: 5 }, () => cancellation.checkpoint());
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    reject(new Error('database timeout'));
    await expect(Promise.all(waiters)).resolves.toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(cancellation.isCancelled()).toBe(false);
    expect(lookup).toHaveBeenCalledTimes(1);
    // The throttle still applies: the next lookup waits 250 ms.
    now = 249;
    await expect(cancellation.checkpoint()).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledTimes(1);
    now = 250;
    await expect(cancellation.checkpoint()).rejects.toBeInstanceOf(ArchiveJobStoppedError);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ jobId: 'job-a', failedLookups: 1 });
  });

  it('logs repeated lookup failures at most once a minute', async () => {
    let now = 0;
    const lookup = vi.fn().mockRejectedValue(new Error('unavailable'));
    const warn = vi.fn();
    const cancellation = new ArchiveJobCancellation('job-a', lookup, {
      now: () => now,
      logger: { warn },
    });
    for (let boundary = 0; boundary < 10; boundary += 1) {
      now = boundary * 1000;
      await cancellation.checkpoint();
    }
    expect(lookup).toHaveBeenCalledTimes(10);
    expect(warn).toHaveBeenCalledTimes(1);
    now = 60_000;
    await cancellation.checkpoint();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]?.[0]).toMatchObject({ failedLookups: 11 });
  });

  it('refreshes when an injected clock moves backwards', async () => {
    let now = 1000;
    const lookup = vi.fn().mockResolvedValue(false);
    const cancellation = new ArchiveJobCancellation('job-a', lookup, { now: () => now });
    await cancellation.checkpoint();
    now = 500;
    await cancellation.checkpoint();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('fails the boundary on a programmer error in the lookup', async () => {
    const lookup = vi.fn().mockRejectedValue(new TypeError('repos.jobs is undefined'));
    const warn = vi.fn();
    const cancellation = new ArchiveJobCancellation('job-a', lookup, { logger: { warn } });
    await expect(cancellation.checkpoint()).rejects.toBeInstanceOf(TypeError);
    expect(warn).not.toHaveBeenCalled();
    expect(cancellation.isCancelled()).toBe(false);
  });
});
