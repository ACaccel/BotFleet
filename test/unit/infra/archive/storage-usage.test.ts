import { mkdtemp, mkdir, writeFile, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ArchiveStorageMonitor,
  measureStorageRoots,
} from '../../../../src/infra/archive/storage-usage';

describe('archive storage inventory', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps in-flight allocation charged across refresh and until a post-completion sample', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    let physicalUsed = 40;
    const monitor = new ArchiveStorageMonitor(
      async () => ({
        measuredAt: Date.now(),
        usedBytes: physicalUsed,
        availableBytes: 100,
        roots: [],
      }),
      100,
      70,
      10,
    );
    await monitor.reserve(0, true);
    let finish!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const write = monitor.withReservation(15, true, async () => {
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    await began;
    await monitor.refresh();
    await expect(monitor.reserve(10, true)).rejects.toThrow('backfill paused');
    physicalUsed = 41;
    finish();
    await write;
    await expect(monitor.reserve(10, true)).rejects.toThrow('backfill paused');
    await monitor.refresh();
    await expect(monitor.reserve(10, true)).resolves.toMatchObject({ usedBytes: 41 });
  });

  it('retains new admissions made during a coalesced background sample even after completion', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    let finishSample!: (value: {
      measuredAt: number;
      usedBytes: number;
      availableBytes: number;
      roots: string[];
    }) => void;
    const usage = { measuredAt: Date.now(), usedBytes: 40, availableBytes: 100, roots: [] };
    const measure = vi
      .fn()
      .mockResolvedValueOnce(usage)
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            finishSample = resolve;
          }),
      );
    const monitor = new ArchiveStorageMonitor(measure, 100, 70, 10);
    await monitor.reserve(0, true);
    const first = monitor.refresh();
    const second = monitor.refresh();
    await Promise.resolve();
    await monitor.withReservation(15, true, async () => undefined);
    finishSample(usage);
    await Promise.all([first, second]);
    expect(measure).toHaveBeenCalledTimes(2);
    await expect(monitor.reserve(10, true)).rejects.toThrow('backfill paused');
  });

  it('clears failed write projections only after fresh measurement and never invokes denied operations', async () => {
    const monitor = new ArchiveStorageMonitor(
      async () => ({ measuredAt: Date.now(), usedBytes: 40, availableBytes: 100, roots: [] }),
      100,
      70,
      10,
    );
    const denied = vi.fn().mockResolvedValue(undefined);
    await expect(monitor.withReservation(30, true, denied)).rejects.toThrow('backfill paused');
    expect(denied).not.toHaveBeenCalled();
    await expect(
      monitor.withReservation(19, true, async () => {
        throw new Error('failed write');
      }),
    ).rejects.toThrow('failed write');
    await expect(monitor.reserve(1, true)).rejects.toThrow('backfill paused');
    await monitor.refresh();
    await expect(monitor.reserve(1, true)).resolves.toBeDefined();
  });

  it('fails closed on expired or invalid measurements', async () => {
    const monitor = new ArchiveStorageMonitor(
      async () => ({
        measuredAt: Date.now() - 30_000,
        usedBytes: 40,
        availableBytes: 100,
        roots: [],
      }),
      100,
      70,
      10,
    );
    await expect(monitor.reserve(1, true)).rejects.toThrow('invalid or expired');
  });

  it('refreshes outside admissions and stops its sampler without duplicate timers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const measure = vi.fn(async () => ({
      measuredAt: Date.now(),
      usedBytes: 40,
      availableBytes: 100,
      roots: [],
    }));
    const monitor = new ArchiveStorageMonitor(measure, 100, 70, 10);
    await monitor.reserve(0, true);
    monitor.start();
    monitor.start();
    await vi.advanceTimersByTimeAsync(15000);
    expect(measure).toHaveBeenCalledTimes(2);
    monitor.stop();
    await vi.advanceTimersByTimeAsync(30000);
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it('counts nested roots and hard links only once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'archive-budget-'));
    try {
      await mkdir(join(root, 'data'));
      await writeFile(join(root, 'data', 'blob'), Buffer.alloc(8192));
      await link(join(root, 'data', 'blob'), join(root, 'copy'));
      const one = await measureStorageRoots([root]);
      const nested = await measureStorageRoots([root, join(root, 'data'), root]);
      expect(nested.usedBytes).toBe(one.usedBytes);
      expect(nested.roots).toEqual([root]);
      expect(nested.availableBytes).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reserves concurrent writes and leaves capacity for capture', async () => {
    const monitor = new ArchiveStorageMonitor(
      async () => ({ measuredAt: Date.now(), usedBytes: 40, availableBytes: 100, roots: [] }),
      100,
      70,
      10,
    );
    await monitor.reserve(15, true);
    await expect(monitor.reserve(10, true)).rejects.toThrow('backfill paused');
    await expect(monitor.reserve(10, false)).resolves.toMatchObject({ usedBytes: 40 });
    await expect(monitor.reserve(26, false)).rejects.toThrow('capture blocked');
  });

  it('fails closed when capacity cannot be measured', async () => {
    const monitor = new ArchiveStorageMonitor(
      async () => {
        throw new Error('unavailable');
      },
      100,
      70,
      10,
    );
    await expect(monitor.reserve(1, true)).rejects.toThrow('unavailable');
  });
});
