import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadConfig, ensurePrivateState, validateBackupMetadata } from './config.mjs';
import {
  checkBundle,
  contains,
  copyRecords,
  excludeCode,
  fail,
  inventoryFiles,
  inventoryIgnored,
  readJson,
  safePath,
  writeJson,
} from './files.mjs';

/** @typedef {{version:string,databases:{name:string,collections:unknown[]}[]}} DatabaseInventory */
/** @typedef {{MONGODB_VERSION:string,MONGO_TOOLS_VERSION:string,NODE_VERSION:string,YARN_VERSION:string,MONGOSH_VERSION:string}} Runtime */
const toolDir = path.dirname(fileURLToPath(import.meta.url));
const usage = `Usage (inside a BotFleet git checkout):
  migration.sh inspect
  migration.sh export --writers-stopped
  migration.sh restore /absolute/backup-directory [--mongo-dir /absolute/path]
  migration.sh verify /absolute/backup-directory
Optional: --config /absolute/config.json
Bare target: bash BACKUP/tool/bootstrap.sh --env dc --runtime BACKUP/runtime.conf --apply`;

/** @param {string} binary @param {string[]} args @param {{cwd?:string,env?:NodeJS.ProcessEnv,allowFailure?:boolean}} [options] @returns {Promise<{code:number,text:string}>} */
function run(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.on('data', (chunk) => {
      if (text.length < 8 * 1024 * 1024) text += chunk;
    });
    // Subprocess diagnostics may contain credentials. Report the failed executable only.
    child.stderr.resume();
    child.once('error', () =>
      reject(new Error(`Cannot execute ${path.basename(binary)}; check the active environment.`)),
    );
    child.once('close', (code) => {
      if (code !== 0 && !options.allowFailure)
        reject(new Error(`${path.basename(binary)} failed; no success state was saved.`));
      else resolve({ code: code ?? 1, text });
    });
  });
}

/** @param {import('./config.mjs').Config} config @returns {NodeJS.ProcessEnv} */
const environment = (config) => ({
  ...process.env,
  PATH: `${config.environment}/bin:${process.env.PATH ?? ''}`,
});

/** @param {import('./config.mjs').Config} config @param {string} name @returns {Promise<string>} */
async function binary(config, name) {
  const candidates = [
    path.join(config.environment, 'bin', name),
    path.join(path.dirname(process.execPath), name),
    ...(process.env.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, name)),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Try the next runtime location. */
    }
  }
  fail(`Missing ${name}; activate the source runtime or run bootstrap on the target.`);
}

/** @param {import('./config.mjs').Config} config @param {object} request @returns {Promise<void>} */
async function mongo(config, request) {
  const directory = await fs.mkdtemp(path.join(config.stateDir, 'request-'));
  try {
    const filename = path.join(directory, 'request.json');
    await writeJson(filename, request);
    await run(
      await binary(config, 'mongosh'),
      ['--nodb', '--quiet', '--file', path.join(toolDir, 'mongo-run.cjs')],
      {
        env: {
          ...environment(config),
          BOTFLEET_MIGRATION_REQUEST: filename,
          BOTFLEET_MIGRATION_HELPER: path.join(toolDir, 'mongo.cjs'),
        },
      },
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/** @param {string} repo @param {string} relative @returns {Promise<string>} */
async function readUri(repo, relative) {
  if (path.isAbsolute(relative) || !contains(repo, path.resolve(repo, relative)))
    fail('Unsafe MongoDB env path.');
  await safePath(path.join(repo, relative));
  const require = createRequire(path.join(repo, 'package.json'));
  const value = require('dotenv').parse(await fs.readFile(path.join(repo, relative))).MONGO_URI;
  if (typeof value !== 'string' || /[\r\n]/.test(value)) fail('Missing or multiline MONGO_URI.');
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('Invalid MONGO_URI.');
  }
  if (
    url.protocol !== 'mongodb:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    !url.username ||
    !url.password ||
    !['', '/', '/admin'].includes(url.pathname) ||
    (url.searchParams.get('authSource') ?? 'admin') !== 'admin'
  )
    fail('Only local standalone MongoDB with admin authentication is supported.');
  url.pathname = '/';
  url.searchParams.set('authSource', 'admin');
  return url.href;
}

/** @param {import('./config.mjs').Config} config @param {string} uri @param {string} name @param {string[]} args @returns {Promise<void>} */
async function databaseTool(config, uri, name, args) {
  const directory = await fs.mkdtemp(path.join(config.stateDir, 'credentials-'));
  try {
    const filename = path.join(directory, 'mongo.yml');
    await fs.writeFile(filename, `uri: ${JSON.stringify(uri)}\n`, { mode: 0o600, flag: 'wx' });
    await run(await binary(config, name), ['--config', filename, ...args]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/** @param {import('./config.mjs').Config} config @param {string} serverVersion @returns {Promise<Runtime>} */
async function runtime(config, serverVersion) {
  const readVersion = async (name) => {
    const result = await run(await binary(config, name), ['--version']);
    const match = result.text.match(/\b\d+\.\d+\.\d+\b/);
    if (!match) fail(`Cannot determine ${name} version.`);
    return match[0];
  };
  const toolsVersion = await readVersion('mongodump');
  if ((await readVersion('mongorestore')) !== toolsVersion)
    fail('mongodump and mongorestore versions differ.');
  const nodeVersion = (await fs.readFile(path.join(config.repo, '.nvmrc'), 'utf8'))
    .trim()
    .replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(nodeVersion) || !/^\d+\.\d+\.\d+$/.test(serverVersion))
    fail('Exact runtime versions are required.');
  return {
    MONGODB_VERSION: serverVersion,
    MONGO_TOOLS_VERSION: toolsVersion,
    NODE_VERSION: nodeVersion,
    YARN_VERSION: await readVersion('yarn'),
    MONGOSH_VERSION: await readVersion('mongosh'),
  };
}

/** @param {import('./config.mjs').Config} config @returns {Promise<void>} */
async function noWriters(config) {
  for (const pid of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    let cwd, command;
    try {
      cwd = await fs.readlink(`/proc/${pid}/cwd`);
      command = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ');
    } catch {
      continue;
    }
    if (
      (cwd === config.repo || command.includes(`${config.repo}/`)) &&
      /(?:ts-node|node|yarn).*src\/bot\/[^/]+\/index\.(?:ts|js)/.test(command)
    )
      fail('A BotFleet writer is still running; stop it before exporting or restoring.');
  }
}

/** @param {number} port @returns {Promise<void>} */
async function unusedPort(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () =>
      reject(new Error('MongoDB port is occupied; do not restore into an existing server.')),
    );
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

/** @param {import('./config.mjs').Config} config @param {string} output @returns {Promise<DatabaseInventory>} */
async function discover(config, output) {
  await mongo(config, {
    action: 'discover',
    uri: await readUri(config.repo, config.mongoEnv),
    output,
  });
  return /** @type {DatabaseInventory} */ (await readJson(output));
}

/** @param {import('./config.mjs').Config} config @returns {Promise<void>} */
async function exportBackup(config) {
  await noWriters(config);
  const records = await inventoryIgnored(config.repo);
  if (!records.some((record) => record.path === config.mongoEnv))
    fail('mongoEnv must be a gitignored runtime file.');
  await fs.mkdir(config.backupDir, { recursive: true, mode: 0o700 });
  const backup = await fs.mkdtemp(
    path.join(config.backupDir, `${new Date().toISOString().replaceAll(':', '-')}-`),
  );
  const capacity = await fs.statfs(backup);
  if (
    capacity.bavail * capacity.bsize <
    records.reduce((total, record) => total + record.size, 0) * 2
  )
    fail('Insufficient file backup space; MongoDB dump requires additional capacity.');
  const inventoryPath = path.join(backup, 'database.json');
  const inventory = await discover(config, inventoryPath);
  const databases = inventory.databases.map((database) => database.name);
  const versions = await runtime(config, inventory.version);
  const uri = await readUri(config.repo, config.mongoEnv);
  const gitCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: config.repo })).text.trim();
  await fs.mkdir(path.join(backup, 'dump'), { mode: 0o700 });
  for (const name of databases) {
    await databaseTool(config, uri, 'mongodump', [
      '--db',
      name,
      '--gzip',
      '--out',
      path.join(backup, 'dump'),
    ]);
    process.stdout.write(`Exported database ${name}\n`);
  }
  await fs.mkdir(path.join(backup, 'runtime'), { mode: 0o700 });
  await copyRecords(config.repo, path.join(backup, 'runtime'), records);
  if (JSON.stringify(records) !== JSON.stringify(await inventoryIgnored(config.repo)))
    fail('Ignored files changed during export; stop every writer and retry.');
  await noWriters(config);
  await mongo(config, { action: 'verify', uri, databases, expected: inventoryPath });
  // Include only the small recovery tool, never application code or dependencies.
  const helpers = await inventoryFiles(
    toolDir,
    (name) => name !== 'bootstrap-runtime.conf' && !/^[^/]+\.(?:sh|mjs|cjs)$/.test(name),
  );
  await fs.mkdir(path.join(backup, 'tool'), { mode: 0o700 });
  await copyRecords(toolDir, path.join(backup, 'tool'), helpers);
  await fs.writeFile(
    path.join(backup, 'runtime.conf'),
    Object.entries(versions)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
    { mode: 0o600, flag: 'wx' },
  );
  const files = await inventoryFiles(backup);
  await writeJson(path.join(backup, 'manifest.json'), {
    format: 2,
    createdAt: new Date().toISOString(),
    gitCommit,
    mongoEnv: config.mongoEnv,
    databases,
    mongoVersion: inventory.version,
    toolsVersion: versions.MONGO_TOOLS_VERSION,
    mongoPort: Number(new URL(uri).port || 27017),
    files,
  });
  process.stdout.write(
    `Backup complete: ${backup}\nDatabases: ${databases.length}; ignored files: ${records.length}\nClone application revision: ${gitCommit}\nTracked and untracked nonignored application changes are not included. Keep writers stopped until cutover.\n`,
  );
}

/** @param {import('./config.mjs').Config} config @param {string} backup @returns {Promise<{manifest:import('./files.mjs').Manifest,id:string}>} */
async function compatibleBackup(config, backup) {
  const checked = await checkBundle(backup);
  validateBackupMetadata(checked.manifest);
  const actualCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: config.repo })).text.trim();
  if (actualCommit !== checked.manifest.gitCommit)
    fail(`Checkout source revision ${checked.manifest.gitCommit} before restoring.`);
  if (
    (await run('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: config.repo, allowFailure: true }))
      .code !== 0
  )
    fail('Target has tracked changes; use a clean clone.');
  const dumpVersion = (await run(await binary(config, 'mongorestore'), ['--version'])).text;
  const serverVersion = (await run(await binary(config, 'mongod'), ['--version'])).text;
  if (
    dumpVersion.match(/\b\d+\.\d+\.\d+\b/)?.[0] !== checked.manifest.toolsVersion ||
    serverVersion.match(/\b\d+\.\d+\.\d+\b/)?.[0] !== checked.manifest.mongoVersion
  )
    fail('Target database tool versions differ; bootstrap using this backup runtime.conf.');
  if (!checked.manifest.files.some((file) => file.path === `runtime/${checked.manifest.mongoEnv}`))
    fail('Backup is missing its MongoDB env file.');
  return checked;
}

/** @param {import('./config.mjs').Config} config @returns {Promise<void>} */
async function installDependencies(config) {
  const expected = (await fs.readFile(path.join(config.repo, '.nvmrc'), 'utf8'))
    .trim()
    .replace(/^v/, '');
  const actual = (await run(await binary(config, 'node'), ['--version'])).text.trim();
  if (actual !== `v${expected}`)
    fail('Target Node does not match .nvmrc; bootstrap using the source runtime.');
  await run(await binary(config, 'yarn'), ['install', '--frozen-lockfile'], {
    cwd: config.repo,
    env: {
      ...environment(config),
      CFLAGS: `${process.env.CFLAGS ?? ''} -Wno-error=incompatible-pointer-types`,
    },
  });
}

/** @param {import('./config.mjs').Config} config @param {string} backup @param {string} mongoDir @returns {Promise<void>} */
async function restoreBackup(config, backup, mongoDir) {
  const { manifest, id } = await compatibleBackup(config, backup);
  await noWriters(config);
  for (const location of [config.repo, backup, config.environment])
    if (contains(location, mongoDir) || contains(mongoDir, location))
      fail('MongoDB directory must be separate from the repository, backup and conda environment.');
  await unusedPort(manifest.mongoPort);
  if (
    await fs.lstat(mongoDir).then(
      () => true,
      (error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    )
  )
    fail('MongoDB directory already exists; use a new destination.');
  const records = manifest.files
    .filter((file) => file.path.startsWith('runtime/'))
    .map((file) => ({ ...file, path: file.path.slice(8) }));
  const tracked = new Set(
    (await run('git', ['ls-files', '-z'], { cwd: config.repo })).text.split('\0'),
  );
  for (const record of records) {
    if (excludeCode(record.path)) fail('Backup contains an excluded runtime destination.');
    if (tracked.has(record.path))
      fail('A runtime file is tracked in the target checkout; refusing to replace code.');
    await safePath(path.join(config.repo, record.path));
    if (
      await fs.lstat(path.join(config.repo, record.path)).then(
        () => true,
        (error) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        },
      )
    )
      fail('A runtime destination already exists; use a clean clone.');
  }
  await installDependencies(config);
  await copyRecords(path.join(backup, 'runtime'), config.repo, records);
  const uri = await readUri(config.repo, manifest.mongoEnv);
  if (Number(new URL(uri).port || 27017) !== manifest.mongoPort)
    fail('Backup MongoDB port does not match its env file.');
  await fs.mkdir(mongoDir, { mode: 0o700 });
  await fs.mkdir(path.join(mongoDir, 'data'), { mode: 0o700 });
  const conf = path.join(mongoDir, 'mongod.conf');
  await writeJson(conf, {
    storage: { dbPath: path.join(mongoDir, 'data') },
    systemLog: { destination: 'file', path: path.join(mongoDir, 'mongod.log'), logAppend: true },
    net: { port: manifest.mongoPort, bindIp: '127.0.0.1' },
    security: { authorization: 'enabled' },
    processManagement: { fork: true, pidFilePath: path.join(mongoDir, 'mongod.pid') },
  });
  let started = false;
  try {
    await run(await binary(config, 'mongod'), ['--config', conf]);
    started = true;
    const credentials = new URL(uri);
    await mongo(config, {
      action: 'create-user',
      databases: manifest.databases,
      uri: `mongodb://127.0.0.1:${manifest.mongoPort}/admin`,
      user: decodeURIComponent(credentials.username),
      password: decodeURIComponent(credentials.password),
      authDatabase: 'admin',
    });
    await mongo(config, { action: 'empty', uri, databases: manifest.databases });
    await databaseTool(config, uri, 'mongorestore', [
      '--gzip',
      '--stopOnError',
      ...manifest.databases.map((database) => `--nsInclude=${database}.*`),
      path.join(backup, 'dump'),
    ]);
    await verifyBackup(config, backup);
    await writeJson(path.join(config.stateDir, 'restored.json'), {
      backup: id,
      repo: config.repo,
      mongoDir,
    });
  } catch (error) {
    // Only this invocation's dedicated server is eligible for cleanup.
    if (started) {
      const stopped = await run(await binary(config, 'mongod'), ['--config', conf, '--shutdown'], {
        allowFailure: true,
      });
      if (stopped.code !== 0)
        process.stderr.write(`Could not stop the partial restore server; inspect ${conf}.\n`);
    }
    throw error;
  }
  process.stdout.write(
    `Restored ${manifest.databases.length} databases and ${records.length} ignored files. MongoDB is running; bots are not started.\nMongoDB config: ${conf}\nStart the desired bots with their usual yarn commands.\n`,
  );
}

/** @param {import('./config.mjs').Config} config @param {string} backup @returns {Promise<void>} */
async function verifyBackup(config, backup) {
  const { manifest } = await checkBundle(backup);
  validateBackupMetadata(manifest);
  await noWriters(config);
  await mongo(config, {
    action: 'verify',
    uri: await readUri(config.repo, manifest.mongoEnv),
    databases: manifest.databases,
    expected: path.join(backup, 'database.json'),
  });
  const expected = manifest.files
    .filter((file) => file.path.startsWith('runtime/'))
    .map((file) => ({ ...file, path: file.path.slice(8) }));
  const actual = await inventoryIgnored(config.repo);
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    fail(
      'Restored ignored files differ from the backup; keep writers stopped during verification.',
    );
  process.stdout.write(
    'Verified database counts, views, indexes and every ignored-file checksum.\n',
  );
}

async function main() {
  process.umask(0o077);
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['help', '--help'].includes(command)) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (!['inspect', 'export', 'restore', 'verify'].includes(command)) fail(usage);
  let configFile,
    backup,
    mongoDir,
    writersStopped = false;
  while (args.length) {
    const argument = args.shift();
    if (argument === '--writers-stopped' && command === 'export' && !writersStopped)
      writersStopped = true;
    else if (argument === '--config' && !configFile && args[0] && !args[0].startsWith('--'))
      configFile = args.shift();
    else if (
      argument === '--mongo-dir' &&
      command === 'restore' &&
      !mongoDir &&
      args[0] &&
      !args[0].startsWith('--')
    )
      mongoDir = args.shift();
    else if (['restore', 'verify'].includes(command) && !backup && !argument.startsWith('--'))
      backup = argument;
    else fail(usage);
  }
  if (command === 'export' && !writersStopped)
    fail('Stop every writer, then pass --writers-stopped.');
  if (['restore', 'verify'].includes(command) && !backup) fail('Supply the backup directory.');
  const repo = (await run('git', ['rev-parse', '--show-toplevel'])).text.trim();
  const config = await loadConfig(repo, configFile);
  config.stateDir = await safePath(
    path.resolve(
      repo,
      (
        await run('git', ['rev-parse', '--git-path', 'botfleet-migration'], { cwd: repo })
      ).text.trim(),
    ),
  );
  await ensurePrivateState(config);
  const lock = path.join(config.stateDir, 'lock');
  await fs
    .mkdir(lock, { mode: 0o700 })
    .catch(() =>
      fail(
        'Migration is locked; confirm the previous process exited before removing its lock directory.',
      ),
    );
  try {
    if (command === 'inspect') {
      const inventory = await discover(config, path.join(lock, 'inventory.json'));
      const files = await inventoryIgnored(repo);
      process.stdout.write(
        `${JSON.stringify({ databases: inventory.databases.map((database) => database.name), mongoVersion: inventory.version, ignoredFiles: files.map((file) => file.path), ignoredBytes: files.reduce((sum, file) => sum + file.size, 0), backupDir: config.backupDir }, null, 2)}\n`,
      );
    } else if (command === 'export') await exportBackup(config);
    else if (command === 'restore')
      await restoreBackup(
        config,
        await safePath(path.resolve(backup)),
        await safePath(
          mongoDir ?? path.join(path.dirname(repo), `mongodb-${path.basename(repo).toLowerCase()}`),
        ),
      );
    else await verifyBackup(config, await safePath(path.resolve(backup)));
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const message =
    error instanceof Error &&
    !('code' in error) &&
    !/mongodb:\/\/|Unexpected token|JSON|Invalid URL|Cannot find module/.test(error.message)
      ? error.message
      : 'Operation failed; check paths, permissions, configuration and prerequisites.';
  process.stderr.write(`ERROR: ${message}\n`);
  process.exitCode = 1;
});
