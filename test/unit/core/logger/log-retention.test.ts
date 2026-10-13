/**
 * Unit tests for the log-retention pruner. Age is derived from the file
 * name's local date, so every case pins `now` and builds names relative
 * to it rather than touching mtimes.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  existsSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parseLogRetentionDays,
  pruneLogs,
  startLogRetention,
} from '../../../../src/core/logger/log-retention';

let root: string;
// Local noon on a fixed day: stable across DST and timezone settings.
const NOW = new Date(2026, 5, 15, 12, 0, 0);
const now = (): Date => NOW;

const dayKey = (daysAgo: number): string => {
  const d = new Date(2026, 5, 15 - daysAgo);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};

const touch = (...parts: string[]): string => {
  const p = join(root, ...parts);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, 'x');
  return p;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'log-retention-test-'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('parseLogRetentionDays', () => {
  it('accepts whole numbers up to the cap and rejects everything else', () => {
    expect(parseLogRetentionDays('60')).toBe(60);
    expect(parseLogRetentionDays('0')).toBe(0);
    for (const bad of ['', ' 5', '-1', '1.5', 'x', '3651']) {
      expect(parseLogRetentionDays(bad), bad).toBeUndefined();
    }
  });
});

describe('pruneLogs', () => {
  it('keeps the file on the cutoff day and deletes the day before it', async () => {
    const onCutoff = touch('bot', `${dayKey(60)}.log`);
    const older = touch('bot', `${dayKey(61)}.log`);
    const today = touch('bot', `${dayKey(0)}.log`);

    const result = await pruneLogs({ rootDir: root, retentionDays: 60, now });

    expect(result).toEqual({ deleted: 1, failures: 0 });
    expect(existsSync(older)).toBe(false);
    expect(existsSync(onCutoff)).toBe(true);
    expect(existsSync(today)).toBe(true);
  });

  it('prunes bot-level, guild-level and backup transcript names', async () => {
    const botOld = touch('b1', `${dayKey(90)}.log`);
    const guildOld = touch('b1', 'g1', `${dayKey(90)}.log`);
    const backupOld = touch('backup', `msg-archive-123-${dayKey(90)}_10-20-30.log`);
    const backupOnCutoff = touch('backup', `msg-archive-123-${dayKey(60)}_23-59-59.log`);
    const backupNew = touch('backup', `msg-archive-123-${dayKey(1)}_00-00-00.log`);

    await pruneLogs({ rootDir: root, retentionDays: 60, now });

    for (const gone of [botOld, guildOld, backupOld]) expect(existsSync(gone)).toBe(false);
    for (const kept of [backupOnCutoff, backupNew]) expect(existsSync(kept)).toBe(true);
  });

  it('never touches files that do not match a dated pattern', async () => {
    const keep = [
      touch('error.log'),
      touch('b1', 'notes.txt'),
      touch('b1', `${dayKey(90)}.log.gz`),
      touch('b1', `${dayKey(90)}.txt`),
      touch('b1', `prefix-${dayKey(90)}.log`),
      touch('b1', `${dayKey(90)}_10-20-30.log`),
      touch('b1', '2026-13-45.log'),
      touch('b1', '2026-02-30.log'),
    ];

    const result = await pruneLogs({ rootDir: root, retentionDays: 60, now });

    expect(result.deleted).toBe(0);
    for (const p of keep) expect(existsSync(p)).toBe(true);
  });

  it('removes directories it empties but never the root', async () => {
    touch('b1', 'g1', `${dayKey(90)}.log`);
    touch('b2', `${dayKey(90)}.log`);
    const survivor = touch('b3', `${dayKey(1)}.log`);

    await pruneLogs({ rootDir: root, retentionDays: 60, now });

    expect(existsSync(join(root, 'b1'))).toBe(false);
    expect(existsSync(join(root, 'b2'))).toBe(false);
    expect(existsSync(survivor)).toBe(true);
    expect(existsSync(root)).toBe(true);
  });

  it('keeps the root even when everything under it is removed', async () => {
    touch('b1', `${dayKey(90)}.log`);
    await pruneLogs({ rootDir: root, retentionDays: 60, now });
    expect(existsSync(root)).toBe(true);
  });

  it('does not follow or delete symlinks', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'log-retention-outside-'));
    try {
      const outsideFile = join(outside, `${dayKey(90)}.log`);
      writeFileSync(outsideFile, 'x');
      mkdirSync(join(root, 'b1'), { recursive: true });
      symlinkSync(outside, join(root, 'b1', 'linked-dir'));
      symlinkSync(outsideFile, join(root, 'b1', `${dayKey(90)}.log`));

      const result = await pruneLogs({ rootDir: root, retentionDays: 60, now });

      expect(result.deleted).toBe(0);
      expect(existsSync(outsideFile)).toBe(true);
      expect(existsSync(join(root, 'b1', `${dayKey(90)}.log`))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('treats a missing root as nothing to do', async () => {
    const result = await pruneLogs({
      rootDir: join(root, 'does-not-exist'),
      retentionDays: 60,
      now,
    });
    expect(result).toEqual({ deleted: 0, failures: 0 });
  });

  it('tolerates a file vanishing between listing and unlink (ENOENT)', async () => {
    // Two concurrent passes over the same tree: both list every file,
    // so each loses the race on some unlinks. Neither may report failure.
    for (let i = 0; i < 20; i += 1) touch('b1', `${dayKey(100 + i)}.log`);

    const results = await Promise.all([
      pruneLogs({ rootDir: root, retentionDays: 60, now }),
      pruneLogs({ rootDir: root, retentionDays: 60, now }),
    ]);

    expect(results.every((r) => r.failures === 0)).toBe(true);
    expect(results.reduce((n, r) => n + r.deleted, 0)).toBe(20);
    expect(existsSync(join(root, 'b1'))).toBe(false);
  });

  it('reports the first failure of a pass and keeps going', async () => {
    // Root can read a mode-000 directory, so the case is meaningless there.
    if (process.getuid?.() === 0) return;
    const locked = join(root, 'b1');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    const removable = touch('b2', `${dayKey(90)}.log`);
    try {
      const result = await pruneLogs({ rootDir: root, retentionDays: 60, now });

      expect(result.failures).toBe(1);
      expect(result.firstFailure?.path).toBe(locked);
      expect(existsSync(removable)).toBe(false);
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});

describe('startLogRetention', () => {
  it('prunes at start, then on every interval, and stops on stop()', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const onFailure = vi.fn();
    const first = touch('b1', `${dayKey(90)}.log`);

    const retention = startLogRetention({
      rootDir: root,
      retentionDays: 60,
      intervalMs: 1_000,
      now,
      onFailure,
    });
    await vi.waitFor(() => {
      expect(existsSync(first)).toBe(false);
    });

    const second = touch('b1', `${dayKey(91)}.log`);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(existsSync(second)).toBe(false);
    });

    retention.stop();
    expect(vi.getTimerCount()).toBe(0);
    const third = touch('b1', `${dayKey(92)}.log`);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(existsSync(third)).toBe(true);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('unrefs its timer so it cannot keep the process alive', () => {
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, 'setInterval').mockReturnValue({
      unref,
    } as unknown as NodeJS.Timeout);
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);

    startLogRetention({ rootDir: root, retentionDays: 60, onFailure: vi.fn() }).stop();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('hands pass failures to onFailure instead of throwing', async () => {
    const onFailure = vi.fn();
    // A file where the root directory should be makes readdir fail with ENOTDIR.
    const notADir = touch('plain-file');

    const retention = startLogRetention({
      rootDir: notADir,
      retentionDays: 60,
      intervalMs: 60_000,
      onFailure,
    });
    await vi.waitFor(() => {
      expect(onFailure).toHaveBeenCalledWith(notADir, expect.any(Error), 1);
    });
    retention.stop();
  });
});
