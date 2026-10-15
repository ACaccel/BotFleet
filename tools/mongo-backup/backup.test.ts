import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

type Options = { envFile: string; mongoPrefix: string; outDir: string; keep: number };
type DatabaseEntry = { name: string; collections: string[] };
type Deps = {
  listDatabases: () => Promise<DatabaseEntry[]>;
  dump: (database: string, scratch: string, output: string) => Promise<void>;
  now?: () => Date;
};
type Settings = {
  root: string;
  user: string;
  node: string;
  mongoPrefix: string;
  envFile: string;
  backupDir: string;
  keep: number;
};
let backup: {
  parseArgs: (argv: string[]) => Options;
  readUri: (envFile: string) => Promise<string>;
  snapshotName: (date: Date) => string;
  dumpDatabase: (
    prefix: string,
    uri: string,
    scratch: string,
    database: string,
    output: string,
  ) => Promise<void>;
  runBackup: (
    options: Options,
    deps: Deps,
  ) => Promise<{ target: string; databases: number; removed: string[] }>;
};
let installer: {
  readSettings: (
    root: string,
    overrides?: { backupDir?: string; keep?: string },
  ) => Promise<Settings>;
  renderUnits: (settings: Settings) => Record<string, string>;
  parseArgs: (args: string[]) => { action: string; output?: string };
};
let root: string;

beforeAll(async () => {
  backup = await import(path.join(__dirname, 'backup.mjs'));
  installer = await import(path.join(__dirname, 'install.mjs'));
});
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mongo-backup-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const options = (keep = 14): Options => ({
  envFile: path.join(root, '.env'),
  mongoPrefix: path.join(root, 'mongo'),
  outDir: path.join(root, 'backups'),
  keep,
});
const databases: DatabaseEntry[] = [
  { name: 'guild-a', collections: ['messages', 'users'] },
  { name: 'guild-b', collections: [] },
];
async function fakeDump(database: string, _scratch: string, output: string): Promise<void> {
  const entry = databases.find((item) => item.name === database);
  if (!entry || entry.collections.length === 0) return;
  await fs.mkdir(path.join(output, database), { recursive: true });
  for (const collection of entry.collections)
    await fs.writeFile(path.join(output, database, `${collection}.bson.gz`), 'data');
}
const at = (iso: string) => () => new Date(iso);
// Built at runtime so the secret scanner does not read synthetic fixtures as credentials.
const login = ['user', 'pass'].join(':');
const local = (rest: string) => `mongodb://${login}@${rest}`;

describe('backup arguments', () => {
  it('requires absolute paths and defaults to keeping 3 snapshots', () => {
    const args = ['--env-file', '/a/.env', '--mongo-prefix', '/m', '--out-dir', '/b'];
    expect(backup.parseArgs(args)).toEqual({
      envFile: '/a/.env',
      mongoPrefix: '/m',
      outDir: '/b',
      keep: 3,
    });
    expect(() => backup.parseArgs(['--env-file', 'relative', '--mongo-prefix', '/m'])).toThrow(
      /Usage/,
    );
    expect(() => backup.parseArgs([...args, '--keep', '0'])).toThrow(/positive integer/);
    expect(() => backup.parseArgs([...args, '--unknown', 'x'])).toThrow(/Usage/);
  });

  it('reads MONGO_URI from the env file and rejects other schemes', async () => {
    const file = path.join(root, '.env');
    await fs.writeFile(file, `MONGO_URI=${local('127.0.0.1:27017/?authSource=admin')}\n`);
    await expect(backup.readUri(file)).resolves.toBe(local('127.0.0.1:27017/?authSource=admin'));
    await fs.writeFile(file, `MONGO_URI=${local('127.0.0.1:27017')}\n`);
    await expect(backup.readUri(file)).resolves.toBe(local('127.0.0.1:27017/?authSource=admin'));
    await fs.writeFile(file, `MONGO_URI=${local('localhost/botfleet?tls=false')}\n`);
    await expect(backup.readUri(file)).resolves.toBe(
      local('localhost/?tls=false&authSource=botfleet'),
    );
    await fs.writeFile(file, 'MONGO_URI=https://example.invalid\n');
    await expect(backup.readUri(file)).rejects.toThrow(/mongodb: scheme/);
    await fs.writeFile(file, 'OTHER=1\n');
    await expect(backup.readUri(file)).rejects.toThrow(/Missing/);
  });

  it('names snapshots with a sortable UTC timestamp', () => {
    expect(backup.snapshotName(new Date('2026-10-15T19:30:05.123Z'))).toBe(
      'mongodb-20261015T193005Z',
    );
  });
});

describe('runBackup', () => {
  it('writes a verified snapshot with a manifest and leaves no scratch files', async () => {
    const result = await backup.runBackup(options(), {
      listDatabases: async () => databases,
      dump: fakeDump,
      now: at('2026-10-15T19:30:00Z'),
    });
    expect(result).toEqual({
      target: path.join(root, 'backups/mongodb-20261015T193000Z'),
      databases: 2,
      removed: [],
    });
    const manifest = JSON.parse(
      await fs.readFile(path.join(result.target, 'manifest.json'), 'utf8'),
    );
    expect(manifest).toEqual({ format: 1, createdAt: '2026-10-15T19:30:00.000Z', databases });
    expect(await fs.readdir(path.join(root, 'backups'))).toEqual(['mongodb-20261015T193000Z']);
    expect((await fs.stat(path.join(root, 'backups'))).mode & 0o777).toBe(0o700);
  });

  it('prunes the oldest snapshots beyond the retention count and stale scratch', async () => {
    const out = path.join(root, 'backups');
    await fs.mkdir(path.join(out, 'mongodb-20261013T193000Z'), { recursive: true });
    await fs.mkdir(path.join(out, 'mongodb-20261014T193000Z'));
    await fs.mkdir(path.join(out, '.staging-crashed'));
    await fs.mkdir(path.join(out, 'unrelated'));
    const result = await backup.runBackup(options(2), {
      listDatabases: async () => databases,
      dump: fakeDump,
      now: at('2026-10-15T19:30:00Z'),
    });
    expect(result.removed).toEqual(['mongodb-20261013T193000Z']);
    expect((await fs.readdir(out)).sort()).toEqual([
      'mongodb-20261014T193000Z',
      'mongodb-20261015T193000Z',
      'unrelated',
    ]);
  });

  it('discards the snapshot and keeps older ones when a collection is missing', async () => {
    const out = path.join(root, 'backups');
    await fs.mkdir(path.join(out, 'mongodb-20261014T193000Z'), { recursive: true });
    await expect(
      backup.runBackup(options(1), {
        listDatabases: async () => [{ name: 'guild-a', collections: ['messages', 'missing'] }],
        dump: fakeDump,
        now: at('2026-10-15T19:30:00Z'),
      }),
    ).rejects.toThrow('Dump is missing guild-a.missing.');
    expect(await fs.readdir(out)).toEqual(['mongodb-20261014T193000Z']);
  });

  it('refuses an empty server, an existing snapshot and a concurrent run', async () => {
    const deps = {
      listDatabases: async () => databases,
      dump: fakeDump,
      now: at('2026-10-15T19:30:00Z'),
    };
    await expect(
      backup.runBackup(options(), { ...deps, listDatabases: async () => [] }),
    ).rejects.toThrow('No application databases found.');
    await backup.runBackup(options(), deps);
    await expect(backup.runBackup(options(), deps)).rejects.toThrow(/already exists/);
    await fs.writeFile(path.join(root, 'backups/.lock'), String(process.pid));
    await expect(
      backup.runBackup(options(), { ...deps, now: at('2026-10-16T19:30:00Z') }),
    ).rejects.toThrow('Another backup is running.');
  });
});

describe('dumpDatabase', () => {
  const uri = `mongodb://${['backup', 's3cret%2Fpw'].join(':')}@127.0.0.1:27017/?authSource=admin`;
  async function fakeMongodump(script: string): Promise<string> {
    const prefix = path.join(root, 'mongo');
    await fs.mkdir(path.join(prefix, 'bin'), { recursive: true });
    await fs.writeFile(path.join(prefix, 'bin/mongodump'), `#!/bin/sh\n${script}\n`, {
      mode: 0o755,
    });
    return prefix;
  }

  it('passes the URI through a private config file, never argv', async () => {
    const log = path.join(root, 'call.log');
    const prefix = await fakeMongodump(
      `echo "$@" > ${log}; stat -c %a "$2" >> ${log}; cat "$2" >> ${log}`,
    );
    await backup.dumpDatabase(prefix, uri, root, 'guild-a', path.join(root, 'out'));
    const [args, mode, config] = (await fs.readFile(log, 'utf8')).split('\n');
    expect(args).toMatch(/^--config \S+\/mongo\.yml --db guild-a --gzip --out \S+$/);
    expect(args).not.toContain('s3cret');
    expect(mode).toBe('600');
    expect(config).toBe(`uri: "${uri}"`);
    expect((await fs.readdir(root)).filter((name) => name.startsWith('.credentials-'))).toEqual([]);
  });

  it('redacts credentials from mongodump errors', async () => {
    const prefix = await fakeMongodump(
      `echo "writing progress" >&2; echo "auth failed for ${uri} pw s3cret/pw" >&2; exit 1`,
    );
    const failure = backup.dumpDatabase(prefix, uri, root, 'guild-a', path.join(root, 'out'));
    await expect(failure).rejects.toThrow(
      'mongodump failed for guild-a: auth failed for <redacted> pw <redacted>',
    );
  });
});

describe('install', () => {
  async function deployment(config: object): Promise<void> {
    await fs.writeFile(path.join(root, 'deployment.json'), JSON.stringify(config));
  }
  const mongodb = {
    prefix: '/srv/mongo/.conda',
    configFile: '/srv/mongo/mongod.conf',
    probeEnvFile: '/srv/bot/src/bot/nijika/.env',
  };

  it('derives settings from deployment.json', async () => {
    await deployment({ user: 'botfleet', bots: ['nijika'], mongodb });
    expect(await installer.readSettings(root)).toEqual({
      root,
      user: 'botfleet',
      node: path.join(root, '.conda/bin/node'),
      mongoPrefix: '/srv/mongo/.conda',
      envFile: '/srv/bot/src/bot/nijika/.env',
      backupDir: '/var/backups/botfleet',
      keep: 3,
    });
    await deployment({ user: 'botfleet', runtimePrefix: '/opt/node', mongodb });
    const custom = await installer.readSettings(root, { backupDir: '/data/bk', keep: '7' });
    expect(custom).toMatchObject({ node: '/opt/node/bin/node', backupDir: '/data/bk', keep: 7 });
  });

  it('rejects missing MongoDB settings, root and invalid overrides', async () => {
    await expect(installer.readSettings(root)).rejects.toThrow(/Configure deployment.json/);
    await deployment({ user: 'botfleet' });
    await expect(installer.readSettings(root)).rejects.toThrow(/mongodb is required/);
    await deployment({ user: 'root', mongodb });
    await expect(installer.readSettings(root)).rejects.toThrow(/ordinary service user/);
    await deployment({ user: 'botfleet', mongodb });
    await expect(installer.readSettings(root, { keep: '-1' })).rejects.toThrow(/positive/);
    await expect(installer.readSettings(root, { backupDir: 'rel' })).rejects.toThrow(/--dir/);
    await expect(installer.readSettings(root, { backupDir: '/a b' })).rejects.toThrow(/--dir/);
    await expect(installer.readSettings(root, { backupDir: '/a/../b' })).rejects.toThrow(/--dir/);
  });

  it('renders a hardened oneshot service and a persistent daily timer', async () => {
    const units = installer.renderUnits({
      root: '/srv/bot',
      user: 'botfleet',
      node: '/srv/bot/.conda/bin/node',
      mongoPrefix: '/srv/mongo/100%$',
      envFile: '/srv/bot/src/bot/nijika/.env',
      backupDir: '/var/backups/botfleet',
      keep: 7,
    });
    const service = units['botfleet-mongo-backup.service'];
    const timer = units['botfleet-mongo-backup.timer'];
    expect(service).toMatch(/^# Managed by BotFleet: \/srv\/bot\n/);
    expect(service).toContain('Type=oneshot\nUser=botfleet\n');
    expect(service).toContain(
      'ExecStart="/srv/bot/.conda/bin/node" "/srv/bot/tools/mongo-backup/backup.mjs" "--env-file" "/srv/bot/src/bot/nijika/.env" "--mongo-prefix" "/srv/mongo/100%%$$" "--out-dir" "/var/backups/botfleet" "--keep" "7"',
    );
    expect(service).toContain('ProtectSystem=strict\nProtectHome=read-only\n');
    expect(service).toContain('ReadWritePaths=/var/backups/botfleet\n');
    expect(timer).toContain('OnCalendar=*-*-* 03:30:00\n');
    expect(timer).toContain('Persistent=true\n');
    expect(timer).toContain('WantedBy=timers.target\n');
  });

  it('parses install, uninstall and render arguments', () => {
    expect(installer.parseArgs(['install', '--keep', '7'])).toEqual({
      action: 'install',
      keep: '7',
    });
    expect(installer.parseArgs(['render', '/tmp/out'])).toEqual({
      action: 'render',
      output: '/tmp/out',
    });
    expect(() => installer.parseArgs(['render', 'relative'])).toThrow(/Usage/);
    expect(() => installer.parseArgs(['uninstall', '--keep', '1'])).toThrow(/Usage/);
    expect(() => installer.parseArgs(['upgrade'])).toThrow(/Usage/);
  });
});
