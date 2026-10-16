import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ArchiveStorageSampler,
  measureStorageRoots,
} from '../../../../src/infra/archive/storage-usage';

const { vanished, broken } = vi.hoisted(() => ({
  vanished: new Set<string>(),
  broken: new Set<string>(),
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    lstat: async (path: string) => {
      if (vanished.has(path))
        throw Object.assign(new Error(`ENOENT: no such file, lstat '${path}'`), { code: 'ENOENT' });
      if (broken.has(path))
        throw Object.assign(new Error(`EIO: i/o error, lstat '${path}'`), { code: 'EIO' });
      return actual.lstat(path);
    },
  };
});

describe('archive storage walk', () => {
  it('counts a file removed during the walk as gone, but not a missing root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'archive-walk-'));
    try {
      await mkdir(join(root, 'db'));
      await writeFile(join(root, 'db', 'dropped.wt'), Buffer.alloc(65_536));
      const whole = (await measureStorageRoots([root])).usedBytes;
      const file = (await measureStorageRoots([join(root, 'db', 'dropped.wt')])).usedBytes;
      vanished.add(join(root, 'db', 'dropped.wt'));
      expect(await measureStorageRoots([root])).toMatchObject({
        roots: [root],
        usedBytes: whole - file,
      });
      vanished.add(root);
      await expect(measureStorageRoots([root])).rejects.toThrow('ENOENT');
    } finally {
      vanished.clear();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails a sample whose stable walk fails once the stable size has aged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'archive-walk-'));
    let now = 1000;
    try {
      await mkdir(join(root, 'stable', 'unreadable'), { recursive: true });
      await mkdir(join(root, 'db'));
      const sampler = new ArchiveStorageSampler({
        resolveRoots: async () => ({ stable: [join(root, 'stable')], live: [join(root, 'db')] }),
        stableMaxAgeMs: 60_000,
        now: () => now,
      });
      await sampler.sample();
      broken.add(join(root, 'stable', 'unreadable'));
      // Within its age the stable size is reused without walking.
      now += 59_000;
      await expect(sampler.sample()).resolves.toBeDefined();
      now += 1000;
      await expect(sampler.sample()).rejects.toThrow('EIO');
    } finally {
      broken.clear();
      await rm(root, { recursive: true, force: true });
    }
  });
});
