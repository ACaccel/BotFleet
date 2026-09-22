import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

type Config = {
  repo: string;
  environment: string;
  databaseEnvironment: string;
  mongoEnv: string;
  backupDir: string;
  stateDir: string;
};
let loadConfig: (repo: string, filename?: string, activeEnvironment?: string) => Promise<Config>;
let validateBackupMetadata: (value: unknown) => unknown;
let inventoryFiles: (repo: string) => Promise<unknown[]>;
let root: string;
let repo: string;
let environment: string;
const cli = path.join(__dirname, 'cli.mjs');

beforeAll(async () => {
  ({ loadConfig, validateBackupMetadata } = await import(path.join(__dirname, 'config.mjs')));
  ({ inventoryFiles } = await import(path.join(__dirname, 'files.mjs')));
});
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-cli-'));
  repo = path.join(root, 'repo');
  environment = path.join(root, 'conda/envs/test');
  await fs.mkdir(path.join(environment, 'conda-meta'), { recursive: true });
  await fs.writeFile(path.join(environment, 'conda-meta/history'), '');
  await fs.mkdir(repo);
  git(['init', '-q']);
  await fs.writeFile(
    path.join(repo, '.gitignore'),
    '.env\nconfig.json\nnode_modules/\nlogs/\ndata/\n',
  );
  await fs.writeFile(path.join(repo, '.nvmrc'), '22.13.0');
  await fs.writeFile(path.join(repo, 'package.json'), '{}');
  git(['add', '.']);
  git([
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function git(args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
async function config(value: unknown): Promise<string> {
  const filename = path.join(root, 'config.json');
  await fs.writeFile(filename, JSON.stringify(value));
  return filename;
}
async function exists(filename: string): Promise<boolean> {
  return fs.access(filename).then(
    () => true,
    () => false,
  );
}
async function stub(name: string, body: string): Promise<void> {
  await fs.mkdir(path.join(environment, 'bin'), { recursive: true });
  await fs.writeFile(path.join(environment, 'bin', name), `#!${process.execPath}\n${body}\n`, {
    mode: 0o700,
  });
}
function invoke(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { HOME: root, PATH: `${environment}/bin:/usr/bin:/bin`, CONDA_PREFIX: environment },
  });
}
function metadata() {
  return {
    format: 2,
    createdAt: new Date().toISOString(),
    gitCommit: git(['rev-parse', 'HEAD']),
    mongoEnv: 'src/bot/tomori/.env',
    databases: ['application'],
    mongoPort: 27017,
    mongoVersion: '7.0.34',
    toolsVersion: '100.13.0',
    files: [],
  };
}
async function backup(change: Record<string, unknown> = {}): Promise<string> {
  const directory = path.join(root, 'backup');
  await fs.mkdir(path.join(directory, 'runtime/src/bot/tomori'), { recursive: true });
  await fs.writeFile(path.join(directory, 'runtime/src/bot/tomori/.env'), 'MONGO_URI=fixture');
  await fs.writeFile(
    path.join(directory, 'manifest.json'),
    JSON.stringify({ ...metadata(), ...change, files: await inventoryFiles(directory) }),
  );
  return directory;
}

describe('runtime configuration', () => {
  it('uses the active environment and derives backup/state paths', async () => {
    const result = await loadConfig(repo, undefined, environment);
    expect(result.environment).toBe(environment);
    expect(result.mongoEnv).toBe('src/bot/tomori/.env');
    expect(result.backupDir).toBe(path.join(root, 'botfleet-backups'));
    expect(result.stateDir).toBe(path.join(repo, '.git/botfleet-migration'));
  });
  it('accepts project-local application and separate database environments', async () => {
    const app = path.join(repo, '.conda');
    await fs.mkdir(path.join(app, 'conda-meta'), { recursive: true });
    await fs.writeFile(path.join(app, 'conda-meta/history'), '');
    const result = await loadConfig(
      repo,
      await config({ environment: app, databaseEnvironment: environment }),
    );
    expect(result.environment).toBe(app);
    expect(result.databaseEnvironment).toBe(environment);
  });
  it('defaults the database runtime to the legacy combined environment', async () => {
    expect((await loadConfig(repo, undefined, environment)).databaseEnvironment).toBe(environment);
  });
  it('rejects separate database runtime inside the repository or backup', async () => {
    const databaseEnvironment = path.join(repo, 'database');
    await fs.mkdir(path.join(databaseEnvironment, 'conda-meta'), { recursive: true });
    await fs.writeFile(path.join(databaseEnvironment, 'conda-meta/history'), '');
    await expect(
      loadConfig(repo, await config({ environment, databaseEnvironment })),
    ).rejects.toThrow('overlap');
    await expect(
      loadConfig(
        repo,
        await config({
          environment,
          databaseEnvironment: environment,
          backupDir: path.dirname(environment),
        }),
      ),
    ).rejects.toThrow('overlap');
  });
  it('reads all three source settings without exposing credentials', async () => {
    const values = {
      environment,
      mongoEnv: 'src/bot/nijika/.env',
      backupDir: path.join(root, 'backups'),
    };
    expect(await loadConfig(repo, await config(values))).toMatchObject(values);
  });
  it('rejects obsolete and misspelled fields', async () => {
    await expect(
      loadConfig(
        repo,
        await config({ environment, bundle: '/tmp/old', stateDir: '/tmp/old-state' }),
      ),
    ).rejects.toThrow('Unknown');
  });
  it('rejects escaping env paths and overlapping backup paths', async () => {
    await expect(
      loadConfig(repo, await config({ environment, mongoEnv: '../outside' })),
    ).rejects.toThrow('inside');
    await expect(
      loadConfig(repo, await config({ environment, backupDir: path.join(repo, 'backups') })),
    ).rejects.toThrow('overlap');
  });
  it('rejects symlink paths and non-conda environments', async () => {
    const alias = path.join(root, 'alias');
    await fs.symlink(environment, alias);
    await expect(loadConfig(repo, await config({ environment: alias }))).rejects.toThrow(
      'Symlinks',
    );
    await expect(loadConfig(repo, await config({ environment: root }))).rejects.toThrow();
  });
  it('rejects missing explicit configuration instead of silently using defaults', async () => {
    await expect(loadConfig(repo, path.join(root, 'missing.json'), environment)).rejects.toThrow();
  });
});

describe('backup metadata', () => {
  it('accepts automatically discovered metadata', () => {
    expect(validateBackupMetadata(metadata())).toBeDefined();
  });
  it.each([
    { mongoPort: 0 },
    { mongoPort: 65536 },
    { mongoPort: '27017' },
    { mongoVersion: '7.0' },
    { gitCommit: 'HEAD; touch file' },
    { mongoEnv: '../outside' },
    { mongoEnv: '.git/config' },
    { databases: ['admin'] },
    { databases: [] },
    { databases: ['a', 'a'] },
  ])('rejects unsafe metadata %j', (change) => {
    expect(() => validateBackupMetadata({ ...metadata(), ...change })).toThrow();
  });
});

describe('simplified CLI failures', () => {
  it('requires stopped-writer acknowledgement before creating state', () => {
    const result = invoke(['export']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--writers-stopped');
  });
  it('requires a backup for restore', () => {
    expect(invoke(['restore']).stderr).toContain('Supply the backup');
  });
  it('rejects altered target code before invoking dependencies', async () => {
    const directory = await backup();
    await fs.writeFile(path.join(repo, 'package.json'), '{}\n');
    const result = invoke(['restore', directory]);
    expect(result.stderr).toContain('tracked changes');
    expect(await exists(path.join(repo, '.git/botfleet-migration/lock'))).toBe(false);
  });
  it('does not accept a database version prefix match', async () => {
    const directory = await backup({ mongoVersion: '7.0.3' });
    await stub('mongod', 'console.log("db version v7.0.34")');
    await stub('mongorestore', 'console.log("mongorestore version: 100.13.0")');
    const result = invoke(['restore', directory]);
    expect(result.stderr).toContain('versions differ');
    expect(await exists(path.join(repo, 'src/bot/tomori/.env'))).toBe(false);
  });
  it('does not fall back to PATH for a missing configured database executable', async () => {
    const directory = await backup();
    const databaseEnvironment = path.join(root, 'missing-tools');
    await fs.mkdir(path.join(databaseEnvironment, 'conda-meta'), { recursive: true });
    await fs.writeFile(path.join(databaseEnvironment, 'conda-meta/history'), '');
    await stub('mongorestore', 'console.log("mongorestore version: 100.13.0")');
    const result = invoke([
      'restore',
      directory,
      '--config',
      await config({ environment, databaseEnvironment }),
    ]);
    expect(result.stderr).toContain('Missing mongorestore in configured runtime');
  });
  it('rejects malformed metadata before running external tools', async () => {
    const directory = await backup({ mongoPort: 0 });
    const result = invoke(['restore', directory]);
    expect(result.stderr).toContain('Invalid backup MongoDB port');
    expect(await exists(path.join(repo, '.git/botfleet-migration/restored.json'))).toBe(false);
  });
  it('checks standalone JavaScript module types', () => {
    const project = path.resolve(__dirname, '../..');
    const result = spawnSync(
      process.execPath,
      [
        path.join(project, 'node_modules/typescript/bin/tsc'),
        '--noEmit',
        '--allowJs',
        '--checkJs',
        '--target',
        'es2022',
        '--module',
        'nodenext',
        '--skipLibCheck',
        ...['config.mjs', 'files.mjs', 'cli.mjs'].map((name) => path.join(__dirname, name)),
      ],
      { cwd: project, encoding: 'utf8' },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
