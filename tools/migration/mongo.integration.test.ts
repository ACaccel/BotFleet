import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtempSync,
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { createServer, createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';

// eslint-disable-next-line no-restricted-syntax -- This opt-in test launches isolated database executables, not the application.
const testEnvironment = { ...process.env };
const binDirectory = testEnvironment.MIGRATION_TEST_BIN_DIR;
const helper = join(__dirname, 'mongo.cjs');

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port allocated');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function ready(port: number, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('Isolated mongod exited before readiness');
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.setTimeout(100);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return;
    await delay(100);
  }
  throw new Error('Isolated mongod readiness timed out');
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

// Explicit opt-in prevents ordinary unit runs from depending on host database tools.
it.skipIf(!binDirectory).each(['combined', 'split'] as const)(
  'exports and restores all application data with %s runtimes',
  async (layout) => {
    const directory = mkdtempSync(join(tmpdir(), 'botfleet-mongo-drill-'));
    const children: ChildProcess[] = [];
    const password = 'isolated-drill-password';
    const user = 'migration_drill';
    const databases = ['migration_drill', 'migration_second'];
    const repo = join(directory, 'source');
    const target = join(directory, 'target');
    const mongoDir = join(directory, 'target-mongo');
    let environment =
      layout === 'split' ? join(repo, '.conda') : join(directory, 'conda/envs/drill');
    const databaseEnvironment = layout === 'split' ? join(mongoDir, '.conda') : environment;
    const databaseBinaries = join(databaseEnvironment, 'bin');
    const binaries = join(environment, 'bin');
    const backupDir = join(directory, 'backups');
    let sequence = 0;
    function privateFile(value: unknown, suffix = '.json'): string {
      const filename = join(directory, `${sequence++}${suffix}`);
      writeFileSync(filename, typeof value === 'string' ? value : JSON.stringify(value), {
        mode: 0o600,
      });
      return filename;
    }
    function run(
      program: string,
      args: string[],
      env = testEnvironment,
      cwd?: string,
    ): ReturnType<typeof spawnSync> {
      return spawnSync(program, args, { env, cwd, encoding: 'utf8', timeout: 60000 });
    }
    function succeed(result: ReturnType<typeof spawnSync>): void {
      expect(result.error).toBeUndefined();
      expect(result.status, String(result.stdout) + String(result.stderr)).toBe(0);
    }
    function invoke(
      action: string,
      uri: string,
      additional: Record<string, unknown> = {},
    ): ReturnType<typeof spawnSync> {
      const request = privateFile({ action, uri, databases, ...additional });
      return run('mongosh', ['--nodb', '--quiet', '--file', join(__dirname, 'mongo-run.cjs')], {
        ...testEnvironment,
        BOTFLEET_MIGRATION_REQUEST: request,
        BOTFLEET_MIGRATION_HELPER: helper,
      });
    }
    function execute(uri: string, script: string): void {
      const request = privateFile({ uri });
      const filename = privateFile(
        `const fs = require('node:fs');\nconst request = JSON.parse(fs.readFileSync(process.env.BOTFLEET_MIGRATION_REQUEST, 'utf8'));\nconst connection = connect(request.uri);\nconst database = connection.getSiblingDB('migration_drill');\n${script}`,
        '.cjs',
      );
      succeed(
        run('mongosh', ['--nodb', '--quiet', '--file', filename], {
          ...testEnvironment,
          BOTFLEET_MIGRATION_REQUEST: request,
        }),
      );
    }
    function cli(cwd: string, command: string, args: string[] = []): ReturnType<typeof spawnSync> {
      return run(
        process.execPath,
        [
          join(__dirname, 'cli.mjs'),
          command,
          '--config',
          privateFile({ environment, databaseEnvironment, backupDir }),
          ...args,
        ],
        {
          ...testEnvironment,
          CONDA_PREFIX: environment,
          PATH: '/usr/bin:/bin',
        },
        cwd,
      );
    }
    try {
      const port = await freePort();
      const sourceData = join(directory, 'source-data');
      mkdirSync(sourceData, { mode: 0o700 });
      const sourceProcess = spawn(
        join(binDirectory!, 'mongod'),
        [
          '--config',
          privateFile({
            security: { authorization: 'enabled' },
            net: { bindIp: '127.0.0.1', port },
            storage: { dbPath: sourceData },
            systemLog: { destination: 'file', path: join(directory, 'source-mongo.log') },
          }),
        ],
        { stdio: 'ignore' },
      );
      children.push(sourceProcess);
      await ready(port, sourceProcess);
      succeed(
        invoke('create-user', `mongodb://127.0.0.1:${port}/admin`, {
          user,
          password,
          authDatabase: 'admin',
        }),
      );
      const connectionUrl = new URL(`mongodb://127.0.0.1:${port}/?authSource=admin`);
      connectionUrl.username = user;
      connectionUrl.password = password;
      const uri = connectionUrl.href;
      succeed(invoke('ping', uri));
      execute(
        uri,
        `database.createCollection('messages', { validator: { channel: { $type: 'string' } } });
        database.messages.insertMany([{ channel: 'first', timestamp: 1 }, { channel: 'second', timestamp: 2 }]);
        database.messages.createIndex({ channel: 1, timestamp: -1 }, { name: 'channel_timestamp', unique: true });
        database.createView('recent', 'messages', [{ $match: { timestamp: { $gt: 1 } } }]);
        connection.getSiblingDB('migration_second').settings.insertOne({ key: 'locale', value: 'en' });`,
      );

      mkdirSync(join(repo, 'src/bot/tomori'), { recursive: true });
      mkdirSync(join(repo, 'data'));
      mkdirSync(join(repo, 'logs'));
      writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.env\nconfig.json\ndata/\nlogs/\n');
      writeFileSync(join(repo, '.nvmrc'), process.version.slice(1));
      writeFileSync(join(repo, 'package.json'), '{}');
      writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3}');
      writeFileSync(join(repo, 'src/bot/tomori/index.ts'), '// Application code comes from Git.\n');
      succeed(run('git', ['init', '--quiet'], testEnvironment, repo));
      succeed(run('git', ['add', '.'], testEnvironment, repo));
      succeed(
        run(
          'git',
          [
            '-c',
            'user.name=Migration Test',
            '-c',
            'user.email=migration@example.invalid',
            'commit',
            '--quiet',
            '-m',
            'test: seed migration fixture',
          ],
          testEnvironment,
          repo,
        ),
      );
      const runtimeFiles = {
        'data/attachment.txt': 'isolated attachment',
        'logs/bot.log': 'retained operational history',
        'src/bot/tomori/.env': `MONGO_URI=${uri}\n`,
        'src/bot/tomori/config.json': '{"language":"en"}',
      };
      for (const [name, content] of Object.entries(runtimeFiles))
        writeFileSync(join(repo, name), content);
      symlinkSync(resolve(__dirname, '../../node_modules'), join(repo, 'node_modules'));
      mkdirSync(binaries, { recursive: true });
      mkdirSync(join(environment, 'conda-meta'));
      writeFileSync(join(environment, 'conda-meta/history'), 'isolated integration fixture');
      if (layout === 'split') {
        mkdirSync(databaseBinaries, { recursive: true });
        mkdirSync(join(databaseEnvironment, 'conda-meta'));
        writeFileSync(join(databaseEnvironment, 'conda-meta/history'), 'isolated split fixture');
      }
      for (const name of ['mongod', 'mongodump', 'mongorestore'])
        symlinkSync(join(binDirectory!, name), join(databaseBinaries, name));
      symlinkSync(process.execPath, join(binaries, 'node'));
      const shellPath = String(run('which', ['mongosh']).stdout).trim();
      symlinkSync(shellPath, join(databaseBinaries, 'mongosh'));
      // Stub package installation only; all database commands and CLI stages use real executables.
      writeFileSync(
        join(binaries, 'npm'),
        `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] === '--version') console.log('10.9.2');
else if (process.argv.slice(2).join(' ') === 'ci') {
  fs.mkdirSync('node_modules', { recursive: true });
  fs.cpSync(${JSON.stringify(resolve(__dirname, '../../node_modules/dotenv'))}, path.join(process.cwd(), 'node_modules/dotenv'), { recursive: true });
} else process.exit(2);
`,
        { mode: 0o700 },
      );
      succeed(cli(repo, 'export', ['--writers-stopped']));
      const backups = readdirSync(backupDir);
      expect(backups).toHaveLength(1);
      const backupName = backups[0];
      if (!backupName) throw new Error('Missing exported backup');
      const backup = join(backupDir, backupName);
      const manifestText = readFileSync(join(backup, 'manifest.json'), 'utf8');
      const manifest = JSON.parse(manifestText);
      expect(manifest.format).toBe(2);
      expect(readFileSync(join(backup, 'runtime.conf'), 'utf8')).toContain('NPM_VERSION=10.9.2');
      expect(manifest.databases).toEqual(databases);
      expect(manifestText).not.toContain(password);
      expect(existsSync(join(backup, 'code'))).toBe(false);
      expect(existsSync(join(backup, 'runtime/node_modules'))).toBe(false);
      expect(existsSync(join(backup, 'runtime/src/bot/tomori/index.ts'))).toBe(false);
      for (const [name, content] of Object.entries(runtimeFiles))
        expect(readFileSync(join(backup, 'runtime', name), 'utf8')).toBe(content);
      const expected = join(backup, 'database.json');
      const inventoryText = readFileSync(expected, 'utf8');
      expect(inventoryText).toContain('channel_timestamp');
      expect(inventoryText).toContain('recent');
      succeed(run('git', ['clone', '--quiet', '--no-local', repo, target]));
      expect(existsSync(join(target, 'src/bot/tomori/.env'))).toBe(false);
      if (layout === 'split') {
        const targetEnvironment = join(target, '.conda');
        cpSync(environment, targetEnvironment, { recursive: true, dereference: false });
        environment = targetEnvironment;
      }
      // Reuse the source port only after stopping this test's own database process.
      await stop(sourceProcess);
      succeed(cli(target, 'restore', [backup, '--mongo-dir', mongoDir]));
      for (const [name, content] of Object.entries(runtimeFiles))
        expect(readFileSync(join(target, name), 'utf8')).toBe(content);
      expect(readFileSync(join(target, 'src/bot/tomori/index.ts'), 'utf8')).toBe(
        '// Application code comes from Git.\n',
      );
      succeed(cli(target, 'verify', [backup]));
      succeed(invoke('verify', uri, { expected }));
      expect(invoke('empty', uri).status).toBe(1);
      const repeated = cli(target, 'restore', [backup, '--mongo-dir', mongoDir]);
      expect(repeated.status).toBe(1);
      for (const [name, content] of Object.entries(runtimeFiles))
        expect(readFileSync(join(target, name), 'utf8')).toBe(content);
      succeed(invoke('verify', uri, { expected }));
      execute(uri, `database.messages.insertOne({ channel: 'third', timestamp: 3 });`);
      const failed = cli(target, 'verify', [backup]);
      expect(failed.status).toBe(1);
      expect(String(failed.stderr)).not.toContain(password);
      expect(String(failed.stderr)).not.toContain('third');
    } finally {
      const targetConfig = join(mongoDir, 'mongod.conf');
      if (existsSync(targetConfig))
        run(join(binDirectory!, 'mongod'), ['--config', targetConfig, '--shutdown']);
      await Promise.all(children.map(stop));
      rmSync(directory, { recursive: true, force: true });
    }
  },
  180000,
);
