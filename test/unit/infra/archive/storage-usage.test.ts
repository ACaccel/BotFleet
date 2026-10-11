import { mkdtemp, mkdir, writeFile, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ArchiveStorageSampler,
  measureStorageRoots,
} from '../../../../src/infra/archive/storage-usage';
import { ArchiveStorageMonitor } from '../../../../src/plugins/message-backup/runtime/storage-monitor';

const LIMITS = { budgetBytes: 100, backgroundLimitBytes: 70, reserveBytes: 10 };
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
      LIMITS,
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
    const monitor = new ArchiveStorageMonitor(measure, LIMITS);
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
      LIMITS,
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
      LIMITS,
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
    const monitor = new ArchiveStorageMonitor(measure, LIMITS);
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
      LIMITS,
    );
    await monitor.reserve(15, true);
    await expect(monitor.reserve(10, true)).rejects.toThrow('backfill paused');
    await expect(monitor.reserve(10, false)).resolves.toMatchObject({ usedBytes: 40 });
    await expect(monitor.reserve(26, false)).rejects.toThrow('capture blocked');
  });

  it('fails closed when capacity cannot be measured', async () => {
    const monitor = new ArchiveStorageMonitor(async () => {
      throw new Error('unavailable');
    }, LIMITS);
    await expect(monitor.reserve(1, true)).rejects.toThrow('unavailable');
  });

  it('admits on the previous sample while a refresh runs within two ages, then waits', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    let finish!: () => void;
    const measure = vi
      .fn()
      .mockResolvedValueOnce({ measuredAt: 1000, usedBytes: 40, availableBytes: 100, roots: [] })
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = () =>
              resolve({ measuredAt: Date.now(), usedBytes: 40, availableBytes: 100, roots: [] });
          }),
      );
    const onError = vi.fn();
    const monitor = new ArchiveStorageMonitor(
      measure,
      { ...LIMITS, maxAgeMs: 30_000 },
      { onError },
    );
    await monitor.reserve(0, true);
    vi.setSystemTime(1000 + 45_000);
    // The writer is not held by the slow sample.
    await expect(monitor.reserve(1, true)).resolves.toMatchObject({ measuredAt: 1000 });
    expect(measure).toHaveBeenCalledTimes(2);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(1000 + 45_000 + 61_000);
    let settled = false;
    const waiting = monitor.reserve(1, true).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    finish();
    await waiting;
    expect(onError).not.toHaveBeenCalled();
  });

  it('logs failed background samples, from the timer and from admission', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const failure = new Error('walk failed');
    const measure = vi
      .fn()
      .mockResolvedValueOnce({ measuredAt: 1000, usedBytes: 40, availableBytes: 100, roots: [] })
      .mockRejectedValue(failure);
    const onError = vi.fn();
    const monitor = new ArchiveStorageMonitor(
      measure,
      { ...LIMITS, maxAgeMs: 30_000 },
      { onError },
    );
    await monitor.reserve(0, true);
    monitor.start();
    await vi.advanceTimersByTimeAsync(15_000);
    await monitor.stop();
    expect(onError).toHaveBeenNthCalledWith(1, failure);
    // Admission within the grace window starts the refresh it does not wait for.
    vi.setSystemTime(1000 + 31_000);
    await expect(monitor.reserve(1, true)).resolves.toMatchObject({ measuredAt: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('waits for a sample still running when it stops', async () => {
    let finish!: () => void;
    const measure = vi.fn(
      () =>
        new Promise<{ measuredAt: number; usedBytes: number; availableBytes: number; roots: [] }>(
          (resolve) => {
            finish = () =>
              resolve({ measuredAt: Date.now(), usedBytes: 40, availableBytes: 100, roots: [] });
          },
        ),
    );
    const monitor = new ArchiveStorageMonitor(measure, LIMITS);
    const sampling = monitor.refresh();
    let stopped = false;
    const stopping = monitor.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await Promise.all([sampling, stopping]);
    expect(stopped).toBe(true);
  });

  it('skips excluded paths and counts the rest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'archive-budget-'));
    try {
      await mkdir(join(root, 'db'));
      await writeFile(join(root, 'db', 'blob'), Buffer.alloc(65_536));
      await writeFile(join(root, 'code'), Buffer.alloc(8192));
      const all = await measureStorageRoots([root]);
      const stable = await measureStorageRoots([root], [join(root, 'db')]);
      const live = await measureStorageRoots([join(root, 'db')]);
      expect(stable.usedBytes).toBeLessThan(all.usedBytes);
      expect(stable.usedBytes + live.usedBytes).toBe(all.usedBytes);
      expect((await measureStorageRoots([join(root, 'db')], [root])).usedBytes).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  describe('stable and live roots', () => {
    const layout = async () => {
      const root = await mkdtemp(join(tmpdir(), 'archive-budget-'));
      await mkdir(join(root, 'project', 'db'), { recursive: true });
      await mkdir(join(root, 'runtime'));
      await writeFile(join(root, 'project', 'code'), Buffer.alloc(8192));
      await writeFile(join(root, 'runtime', 'node'), Buffer.alloc(8192));
      await writeFile(join(root, 'project', 'db', 'collection'), Buffer.alloc(8192));
      const size = async (path: string) => (await measureStorageRoots([path])).usedBytes;
      // The data directory lives inside the project; it is counted once, live.
      const roots = {
        stable: [join(root, 'project'), join(root, 'runtime')],
        live: [join(root, 'project', 'db')],
      };
      const total = async () =>
        (await measureStorageRoots([root])).usedBytes -
        (await measureStorageRoots([root], [join(root, 'project'), join(root, 'runtime')]))
          .usedBytes;
      return { root, roots, size, total };
    };

    it('walks stable roots once per age, before the sample completes, and live roots every time', async () => {
      const { root, roots, size, total } = await layout();
      let now = 1000;
      try {
        const resolveRoots = vi.fn(async () => roots);
        const sampler = new ArchiveStorageSampler({
          resolveRoots,
          stableMaxAgeMs: 60_000,
          now: () => now,
        });
        const expected = await total();
        const first = await sampler.sample();
        expect(first).toMatchObject({ usedBytes: expected, stableMeasuredAt: 1000 });
        expect(first.availableBytes).toBeGreaterThan(0);
        // Growth of the data directory shows at once; stable roots keep their size.
        await writeFile(join(root, 'project', 'db', 'grown'), Buffer.alloc(65_536));
        await writeFile(join(root, 'project', 'log'), Buffer.alloc(65_536));
        const grown = await size(join(root, 'project', 'db', 'grown'));
        const logged = await size(join(root, 'project', 'log'));
        now += 59_999;
        expect(await sampler.sample()).toMatchObject({
          usedBytes: expected + grown,
          stableMeasuredAt: 1000,
        });
        // One age later the stable roots are walked again within the same sample.
        now += 1;
        expect(await sampler.sample()).toMatchObject({
          usedBytes: expected + grown + logged,
          stableMeasuredAt: now,
        });
        expect(resolveRoots).toHaveBeenCalledTimes(1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('walks stable roots every time near the budget and after the clock went back', async () => {
      const { root, roots, size, total } = await layout();
      let now = 100_000;
      try {
        const expected = await total();
        const sampler = new ArchiveStorageSampler({
          resolveRoots: async () => roots,
          stableMaxAgeMs: 60_000,
          exactAboveBytes: expected,
          now: () => now,
        });
        await sampler.sample();
        await writeFile(join(root, 'project', 'log'), Buffer.alloc(65_536));
        const logged = await size(join(root, 'project', 'log'));
        now += 1;
        expect(await sampler.sample()).toMatchObject({
          usedBytes: expected + logged,
          stableMeasuredAt: now,
        });
        const below = new ArchiveStorageSampler({
          resolveRoots: async () => roots,
          stableMaxAgeMs: 60_000,
          exactAboveBytes: Number.MAX_SAFE_INTEGER,
          now: () => now,
        });
        await below.sample();
        now -= 10;
        expect(await below.sample()).toMatchObject({ stableMeasuredAt: now });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
