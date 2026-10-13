import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RETAINED_RELEASES,
  pruneAfterDeploy,
  pruneReleases,
} from '../../../scripts/deployment/retention';

const pid = 4242;
let root: string;
let releases: string;
let sequence = 0;
function release(stamp: number): string {
  const name = `${stamp}-00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;
  mkdirSync(join(releases, name), { recursive: true });
  writeFileSync(join(releases, name, 'manifest.json'), '{}');
  return name;
}
function state(name: string, content: string): void {
  writeFileSync(join(root, '.deploy', name), content);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'botfleet-retention-'));
  releases = join(root, '.deploy/releases');
  mkdirSync(releases, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('release retention', () => {
  it('keeps the three newest releases by numeric timestamp, not lexical order', () => {
    const names = [9, 10, 100, 1000, 20].map((stamp) => release(stamp));
    const result = pruneReleases(root, pid);
    expect(RETAINED_RELEASES).toBe(3);
    expect(result.removed.sort()).toEqual([names[0], names[1]].sort());
    for (const name of [names[2], names[3], names[4]])
      expect(existsSync(join(releases, name!))).toBe(true);
  });

  it('keeps referenced old releases in addition to the newest three', () => {
    const botRelease = release(1);
    const databaseRelease = release(2);
    const unreferenced = release(3);
    const newest = [release(4), release(5), release(6)];
    state('current.json', JSON.stringify({ directory: join(releases, botRelease) }));
    state('mongodb.json', `WorkingDirectory=${join(releases, databaseRelease)}`);
    const result = pruneReleases(root, pid);
    expect(result.removed).toEqual([unreferenced]);
    for (const name of [botRelease, databaseRelease, ...newest])
      expect(existsSync(join(releases, name))).toBe(true);
  });

  it('ignores entries that do not match the release name pattern', () => {
    release(1);
    release(2);
    release(3);
    release(4);
    const foreign = [
      'notes',
      '123-not-a-uuid',
      '.keep',
      'abc-00000000-0000-4000-8000-000000000000',
    ];
    for (const name of foreign) mkdirSync(join(releases, name));
    writeFileSync(join(releases, '5-00000000-0000-4000-8000-ffffffffffff'), 'file');
    const result = pruneReleases(root, pid);
    expect(result.removed).toHaveLength(1);
    for (const name of foreign) expect(existsSync(join(releases, name))).toBe(true);
    expect(existsSync(join(releases, '5-00000000-0000-4000-8000-ffffffffffff'))).toBe(true);
  });

  it('removes symlinks inside a release without touching their targets', () => {
    const old = release(1);
    release(2);
    release(3);
    release(4);
    const shared = join(root, 'data');
    mkdirSync(shared);
    writeFileSync(join(shared, 'keep.txt'), 'important');
    symlinkSync(shared, join(releases, old, 'data'));
    symlinkSync(join(shared, 'keep.txt'), join(releases, old, 'config.json'));
    expect(pruneReleases(root, pid).removed).toEqual([old]);
    expect(existsSync(join(releases, old))).toBe(false);
    expect(readFileSync(join(shared, 'keep.txt'), 'utf8')).toBe('important');
  });

  it('does not follow or delete a release entry that is itself a symlink', () => {
    release(2);
    release(3);
    release(4);
    release(5);
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'file'), 'x');
    symlinkSync(outside, join(releases, '1-00000000-0000-4000-8000-aaaaaaaaaaaa'));
    expect(pruneReleases(root, pid).removed).toHaveLength(1);
    expect(readFileSync(join(outside, 'file'), 'utf8')).toBe('x');
  });

  it('refuses a releases directory that resolves outside the project state', () => {
    const outside = mkdtempSync(join(tmpdir(), 'botfleet-outside-'));
    try {
      rmSync(releases, { recursive: true });
      symlinkSync(outside, releases);
      for (let stamp = 1; stamp <= 5; stamp++)
        mkdirSync(join(outside, `${stamp}-00000000-0000-4000-8000-000000000000`));
      const result = pruneReleases(root, pid);
      expect(result.skipped).toMatch(/resolves elsewhere/);
      expect(existsSync(join(outside, '1-00000000-0000-4000-8000-000000000000'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('skips when a recovery journal exists', () => {
    for (let stamp = 1; stamp <= 5; stamp++) release(stamp);
    state('transaction.json', '{}');
    const result = pruneReleases(root, pid);
    expect(result.skipped).toMatch(/recovery journal/);
    expect(result.removed).toEqual([]);
  });

  it('skips when another process holds the lock but proceeds with its own', () => {
    for (let stamp = 1; stamp <= 5; stamp++) release(stamp);
    state('lock', String(pid + 1));
    expect(pruneReleases(root, pid).skipped).toMatch(/lock/);
    state('lock', String(pid));
    expect(pruneReleases(root, pid).removed).toHaveLength(2);
  });

  it('reports a failed state read as a warning without failing the deployment', () => {
    const names = [1, 2, 3, 4, 5].map((stamp) => release(stamp));
    mkdirSync(join(root, '.deploy/current.json'));
    const log = { log: vi.fn(), warn: vi.fn() };
    expect(() => pruneAfterDeploy(root, pid, log)).not.toThrow();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('release cleanup failed'));
    expect(log.log).not.toHaveBeenCalled();
    for (const name of names) expect(existsSync(join(releases, name))).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)(
    'warns about a release that cannot be removed and still removes the others',
    () => {
      const stuck = release(1);
      const removable = release(2);
      for (const stamp of [3, 4, 5]) release(stamp);
      const locked = join(releases, stuck, 'locked');
      mkdirSync(locked);
      writeFileSync(join(locked, 'file'), 'x');
      chmodSync(locked, 0o500);
      const log = { log: vi.fn(), warn: vi.fn() };
      try {
        expect(() => pruneAfterDeploy(root, pid, log)).not.toThrow();
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(stuck));
        expect(log.log).toHaveBeenCalledWith('Removed 1 old release(s).');
        expect(existsSync(join(releases, removable))).toBe(false);
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );

  it('reports skipped cleanup as a warning', () => {
    release(1);
    state('transaction.json', '{}');
    const log = { log: vi.fn(), warn: vi.fn() };
    pruneAfterDeploy(root, pid, log);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('recovery journal'));
  });
});
