import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

type FileRecord = { path: string; size: number; sha256: string; executable: boolean };
let inventoryIgnored: (repo: string) => Promise<FileRecord[]>;
let inventoryFiles: (root: string) => Promise<FileRecord[]>;
let copyRecords: (source: string, target: string, records: FileRecord[]) => Promise<void>;
let checkBundle: (root: string) => Promise<unknown>;
let directory: string;
let repo: string;
beforeAll(async () => {
  ({ inventoryIgnored, inventoryFiles, copyRecords, checkBundle } = await import(
    path.resolve(__dirname, 'files.mjs')
  ));
});
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-files-'));
  repo = path.join(directory, 'repo');
  await fs.mkdir(repo);
  const result = spawnSync('git', ['init', '--quiet'], { cwd: repo });
  expect(result.status).toBe(0);
});
afterEach(async () => fs.rm(directory, { recursive: true, force: true }));
async function file(name: string, content = name): Promise<void> {
  const filename = path.join(repo, name);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, content);
}

describe('ignored runtime inventory', () => {
  it('includes ignored runtime data and backups, excluding source and regenerated artifacts', async () => {
    await file(
      '.gitignore',
      '.env\nconfig.json\nlogs/\ndata/\nbackups/\nnode_modules/\ndist/\ncoverage/\n.plan/\n.conda/\n.deploy/\ndeployment.json\ntools/migration/\n',
    );
    const included = [
      '.env',
      'logs/root.log',
      'data/file',
      'src/bot/tomori/config.json',
      'src/bot/tomori/logs/bot.log',
      'tools/backups/snapshot',
    ];
    const excluded = [
      '.conda/bin/node',
      '.deploy/releases/old/src/bot/tomori/.env',
      'deployment.json',
      'index.ts',
      'src/other.ts',
      'node_modules/pkg/a',
      'src/node_modules/pkg/b',
      'dist/output',
      'coverage/results',
      '.plan/work',
      'tools/migration/config.json',
      'tools/migration/config.target.json',
      'tools/migration/.state/run/file',
      'tools/migration/dump/a',
      'tools/migration/backups/old-runtime',
      'tools/migration/old.tar.gz',
      'tools/migration/old.archive.gz',
      'tools/migration/settings.local.json',
    ];
    for (const name of [...included, ...excluded]) await file(name);
    await file('data/tracked');
    expect(spawnSync('git', ['add', '-f', 'data/tracked'], { cwd: repo }).status).toBe(0);
    const records = await inventoryIgnored(repo);
    expect(records.map((record) => record.path).sort()).toEqual(included.sort());
    expect(records.map((record) => record.path)).toEqual(
      (await inventoryFiles(repo))
        .filter((record) => included.includes(record.path))
        .map((record) => record.path),
    );
  });
  it('honors ignore negations and does not include nonignored siblings', async () => {
    await file('.gitignore', 'data/*\n!data/public.txt\n');
    await file('data/private.txt');
    await file('data/public.txt');
    expect((await inventoryIgnored(repo)).map((record) => record.path)).toEqual([
      'data/private.txt',
    ]);
  });
  it('rejects selected symlinks and symlinks within ignored directories', async () => {
    await file('.gitignore', 'data/\n.env\n');
    await file('outside');
    await fs.symlink(path.join(repo, 'outside'), path.join(repo, '.env'));
    await expect(inventoryIgnored(repo)).rejects.toThrow(/symlinks/i);
    await fs.rm(path.join(repo, '.env'));
    await fs.mkdir(path.join(repo, 'data'));
    await fs.symlink(path.join(repo, 'outside'), path.join(repo, 'data/link'));
    await expect(inventoryIgnored(repo)).rejects.toThrow(/symlinks/i);
  });
  it('does not traverse excluded dependencies, including dependency symlinks', async () => {
    await file('.gitignore', 'node_modules/\ndata/\n');
    await file('data/keep');
    await fs.mkdir(path.join(repo, 'node_modules'));
    await fs.symlink('/missing', path.join(repo, 'node_modules/link'));
    expect((await inventoryIgnored(repo)).map((record) => record.path)).toEqual(['data/keep']);
  });
  it('rejects control characters and special files', async () => {
    await file('.gitignore', 'data/\n');
    await file('data/bad\tname');
    await expect(inventoryIgnored(repo)).rejects.toThrow('Unsafe');
    await fs.rm(path.join(repo, 'data/bad\tname'));
    expect(spawnSync('mkfifo', [path.join(repo, 'data/pipe')]).status).toBe(0);
    await expect(inventoryIgnored(repo)).rejects.toThrow('regular');
  });
});

describe('runtime restore preflight', () => {
  it('checks all destination collisions before copying any file', async () => {
    await file('a');
    await file('z');
    const records = (await inventoryFiles(repo)).filter(
      (record) => !record.path.startsWith('.git/'),
    );
    const target = path.join(directory, 'target');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'z'), 'existing');
    await expect(copyRecords(repo, target, records)).rejects.toThrow('already exists');
    await expect(fs.access(path.join(target, 'a'))).rejects.toThrow();
    expect(await fs.readFile(path.join(target, 'z'), 'utf8')).toBe('existing');
  });
  it('rejects changed or missing source files before any copy', async () => {
    await file('a');
    await file('z');
    const records = (await inventoryFiles(repo)).filter(
      (record) => !record.path.startsWith('.git/'),
    );
    const target = path.join(directory, 'target');
    await file('z', 'changed');
    await expect(copyRecords(repo, target, records)).rejects.toThrow('changed');
    await expect(fs.access(target)).rejects.toThrow();
    await fs.rm(path.join(repo, 'z'));
    await expect(copyRecords(repo, target, records)).rejects.toThrow();
    await expect(fs.access(target)).rejects.toThrow();
  });
  it('rejects ancestor symlinks and traversal records', async () => {
    await file('data/a');
    const target = path.join(directory, 'target');
    await fs.mkdir(target);
    await fs.symlink(repo, path.join(target, 'data'));
    const records = (await inventoryFiles(repo)).filter((record) =>
      record.path.startsWith('data/'),
    );
    await expect(copyRecords(repo, target, records)).rejects.toThrow('Symlinks');
    const record = records[0];
    if (!record) throw new Error('Missing fixture record');
    await expect(copyRecords(repo, target, [{ ...record, path: '../escape' }])).rejects.toThrow(
      'Unsafe',
    );
  });
  it('preserves executable status and validates format 2 inventory', async () => {
    const bundle = path.join(directory, 'bundle');
    await fs.mkdir(bundle);
    await fs.writeFile(path.join(bundle, 'runtime.conf'), 'version=1', { mode: 0o700 });
    await fs.writeFile(
      path.join(bundle, 'manifest.json'),
      JSON.stringify({ format: 2, files: await inventoryFiles(bundle) }),
    );
    await expect(checkBundle(bundle)).resolves.toBeDefined();
    await fs.chmod(path.join(bundle, 'runtime.conf'), 0o600);
    await expect(checkBundle(bundle)).rejects.toThrow('mismatch');
  });
});
