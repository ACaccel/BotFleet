// Online backup of every Pleiades application database, run daily by systemd.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SYSTEM_DATABASES = new Set(['admin', 'config', 'local']);
const SNAPSHOT = /^mongodb-\d{8}T\d{6}Z$/;
const usage =
  'Usage: backup.mjs --env-file FILE --mongo-prefix DIR --out-dir DIR [--keep N] (absolute paths)';

/** @typedef {{envFile:string,mongoPrefix:string,outDir:string,keep:number}} Options */
/** @typedef {{name:string,collections:string[]}} DatabaseEntry */

/** @param {string[]} argv @returns {Options} */
export function parseArgs(argv) {
  /** @type {Record<string,string>} */
  const keys = {
    '--env-file': 'envFile',
    '--mongo-prefix': 'mongoPrefix',
    '--out-dir': 'outDir',
    '--keep': 'keep',
  };
  /** @type {Record<string,string>} */
  const values = { keep: '3' };
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys[argv[index]];
    const value = argv[index + 1];
    if (!key || value === undefined) throw new Error(usage);
    values[key] = value;
  }
  for (const key of ['envFile', 'mongoPrefix', 'outDir'])
    if (!values[key] || !path.isAbsolute(values[key]) || /[\r\n\0]/.test(values[key]))
      throw new Error(usage);
  if (!/^[1-9]\d*$/.test(values.keep)) throw new Error('--keep must be a positive integer.');
  return {
    envFile: values.envFile,
    mongoPrefix: values.mongoPrefix,
    outDir: values.outDir,
    keep: Number(values.keep),
  };
}

/** @param {string} envFile @returns {Promise<string>} */
export async function readUri(envFile) {
  const value = require('dotenv').parse(await fs.readFile(envFile)).MONGO_URI;
  if (typeof value !== 'string' || /[\r\n]/.test(value))
    throw new Error('Missing or multiline MONGO_URI.');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid MONGO_URI.');
  }
  if (url.protocol !== 'mongodb:') throw new Error('MONGO_URI must use the mongodb: scheme.');
  // mongodump --db would otherwise authenticate against each dumped database.
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!url.searchParams.has('authSource')) url.searchParams.set('authSource', database || 'admin');
  url.pathname = '/';
  return url.href;
}

/** @param {Date} date @returns {string} */
export const snapshotName = (date) =>
  `mongodb-${date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '')}`;

/** @param {string} text @param {string} uri @returns {string} */
function redact(text, uri) {
  const url = new URL(uri);
  const secrets = [uri, url.password, decodeURIComponent(url.password)].filter(Boolean);
  return secrets.reduce((result, secret) => result.split(secret).join('<redacted>'), text);
}

/** @param {string} uri @returns {Promise<DatabaseEntry[]>} */
export async function listDatabases(uri) {
  const { MongoClient } = require('mongoose').mongo;
  const client = await MongoClient.connect(uri, { serverSelectionTimeoutMS: 15_000 });
  try {
    // authorizedDatabases:false fails instead of silently skipping databases the user cannot list.
    const { databases } = await client
      .db('admin')
      .command({ listDatabases: 1, nameOnly: true, authorizedDatabases: false });
    /** @type {DatabaseEntry[]} */
    const result = [];
    for (const { name } of databases) {
      if (SYSTEM_DATABASES.has(name)) continue;
      const collections = await client
        .db(name)
        .listCollections({ type: 'collection' }, { nameOnly: true })
        .toArray();
      result.push({
        name,
        collections: collections
          .map((collection) => collection.name)
          .filter((collection) => !collection.startsWith('system.'))
          .sort(),
      });
    }
    return result.sort((left, right) => left.name.localeCompare(right.name));
  } finally {
    await client.close();
  }
}

/** @param {string} mongoPrefix @param {string} uri @param {string} scratch @param {string} database @param {string} output @returns {Promise<void>} */
export async function dumpDatabase(mongoPrefix, uri, scratch, database, output) {
  const directory = await fs.mkdtemp(path.join(scratch, '.credentials-'));
  try {
    // mongodump reads the URI from a private file so the password never appears in argv.
    const config = path.join(directory, 'mongo.yml');
    await fs.writeFile(config, `uri: ${JSON.stringify(uri)}\n`, { mode: 0o600, flag: 'wx' });
    const binary = path.join(mongoPrefix, 'bin/mongodump');
    const args = ['--config', config, '--db', database, '--gzip', '--out', output];
    await new Promise((resolve, reject) => {
      const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      // Progress also goes to stderr; only the tail carries the failure reason.
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-4096);
      });
      child.once('error', () => reject(new Error(`Cannot execute ${binary}.`)));
      child.once('close', (code) => {
        if (code === 0) resolve(undefined);
        else
          reject(
            new Error(
              `mongodump failed for ${database}: ${redact(stderr.trim().split('\n').at(-1) ?? '', uri) || code}`,
            ),
          );
      });
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/** @param {string} directory @returns {Promise<() => Promise<void>>} */
async function lock(directory) {
  const file = path.join(directory, '.lock');
  try {
    const pid = Number(await fs.readFile(file, 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        throw new Error('Another backup is running.');
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ESRCH') throw error;
      }
    }
    await fs.rm(file, { force: true });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
  }
  await fs.writeFile(file, String(process.pid), { mode: 0o600, flag: 'wx' });
  return () => fs.rm(file, { force: true });
}

/**
 * @param {Options} options
 * @param {{listDatabases:() => Promise<DatabaseEntry[]>, dump:(database:string, scratch:string, output:string) => Promise<void>, now?:() => Date}} deps
 * @returns {Promise<{target:string,databases:number,removed:string[]}>}
 */
export async function runBackup(options, deps) {
  await fs.mkdir(options.outDir, { recursive: true, mode: 0o700 });
  const unlock = await lock(options.outDir);
  try {
    for (const entry of await fs.readdir(options.outDir))
      if (entry.startsWith('.staging-') || entry.startsWith('.credentials-'))
        await fs.rm(path.join(options.outDir, entry), { recursive: true, force: true });
    const createdAt = (deps.now ?? (() => new Date()))();
    const target = path.join(options.outDir, snapshotName(createdAt));
    await fs.access(target).then(
      () => {
        throw new Error(`Snapshot already exists: ${target}`);
      },
      () => undefined,
    );
    const staging = await fs.mkdtemp(path.join(options.outDir, '.staging-'));
    /** @type {DatabaseEntry[]} */
    let databases;
    try {
      databases = await deps.listDatabases();
      if (databases.length === 0) throw new Error('No application databases found.');
      for (const database of databases) await deps.dump(database.name, options.outDir, staging);
      for (const database of databases)
        for (const collection of database.collections)
          await fs.access(path.join(staging, database.name, `${collection}.bson.gz`)).catch(() => {
            throw new Error(`Dump is missing ${database.name}.${collection}.`);
          });
      await fs.writeFile(
        path.join(staging, 'manifest.json'),
        `${JSON.stringify({ format: 1, createdAt: createdAt.toISOString(), databases }, null, 2)}\n`,
        { mode: 0o600, flag: 'wx' },
      );
      await fs.rename(staging, target);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
    const snapshots = (await fs.readdir(options.outDir)).filter((name) => SNAPSHOT.test(name));
    const removed = snapshots.sort().slice(0, -options.keep);
    for (const name of removed)
      await fs.rm(path.join(options.outDir, name), { recursive: true, force: true });
    return { target, databases: databases.length, removed };
  } finally {
    await unlock();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const uri = await readUri(options.envFile);
  const result = await runBackup(options, {
    listDatabases: () => listDatabases(uri),
    dump: (database, scratch, output) =>
      dumpDatabase(options.mongoPrefix, uri, scratch, database, output),
  });
  process.stdout.write(
    `Backup written: ${result.target}\nDatabases: ${result.databases}; removed snapshots: ${result.removed.length}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Backup failed.'}\n`);
    process.exitCode = 1;
  });
