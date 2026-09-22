import fs from 'node:fs/promises';
import path from 'node:path';
import { contains, fail, readJson, safePath } from './files.mjs';

/** @typedef {{environment?:string,databaseEnvironment?:string,mongoEnv?:string,backupDir?:string}} Settings */
/** @typedef {{repo:string,environment:string,databaseEnvironment:string,mongoEnv:string,backupDir:string,stateDir:string}} Config */

/** @param {string} repo @param {string} [filename] @param {string} [activeEnvironment] @returns {Promise<Config>} */
export async function loadConfig(repo, filename, activeEnvironment = process.env.CONDA_PREFIX) {
  repo = await safePath(repo);
  const configFile = filename ?? path.join(repo, 'tools/migration/config.json');
  let settings = /** @type {Settings} */ ({});
  try {
    settings = /** @type {Settings} */ (await readJson(configFile));
  } catch (error) {
    if (filename || error.code !== 'ENOENT') throw error;
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    fail('Configuration must be an object.');
  if (
    Object.keys(settings).some(
      (key) => !['environment', 'databaseEnvironment', 'mongoEnv', 'backupDir'].includes(key),
    )
  )
    fail('Unknown setting; use environment, databaseEnvironment, mongoEnv and backupDir only.');
  for (const value of Object.values(settings))
    if (typeof value !== 'string' || !value) fail('Settings must be nonempty strings.');
  const selectedEnvironment = settings.environment ?? activeEnvironment;
  if (!selectedEnvironment)
    fail('Activate conda first, or set environment in tools/migration/config.json.');
  const environment = await safePath(selectedEnvironment);
  if (!(await fs.stat(path.join(environment, 'conda-meta/history'))).isFile())
    fail('environment must point to a conda environment.');
  const databaseEnvironment = await safePath(settings.databaseEnvironment ?? environment);
  if (!(await fs.stat(path.join(databaseEnvironment, 'conda-meta/history'))).isFile())
    fail('databaseEnvironment must point to a conda environment.');
  const backupDir = await safePath(
    settings.backupDir ?? path.join(path.dirname(repo), 'botfleet-backups'),
  );
  const mongoEnv = settings.mongoEnv ?? 'src/bot/tomori/.env';
  if (
    path.isAbsolute(mongoEnv) ||
    /[\0\r\n]/.test(mongoEnv) ||
    !contains(repo, path.resolve(repo, mongoEnv)) ||
    path.resolve(repo, mongoEnv) === repo
  )
    fail('mongoEnv must name an env file inside the repository.');
  for (const [first, second] of [
    [repo, backupDir],
    ...(environment === path.join(repo, '.conda') ? [] : [[repo, environment]]),
    ...(databaseEnvironment === environment ? [] : [[repo, databaseEnvironment]]),
    [backupDir, databaseEnvironment],
    ...(databaseEnvironment === environment ? [] : [[environment, databaseEnvironment]]),
    [backupDir, environment],
  ]) {
    if (contains(first, second) || contains(second, first))
      fail('Repository, backup directory and conda environment must not overlap.');
  }
  return {
    repo,
    environment,
    databaseEnvironment,
    mongoEnv,
    backupDir,
    stateDir: path.join(repo, '.git/botfleet-migration'),
  };
}

/** @param {Config} config @returns {Promise<void>} */
export async function ensurePrivateState(config) {
  await safePath(config.stateDir);
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const stat = await fs.stat(config.stateDir);
  if (stat.uid !== process.getuid() || stat.mode & 0o077)
    fail('Migration state directory must be owned by this user with mode 0700.');
}

/** @param {unknown} value @returns {import('./files.mjs').Manifest} */
export function validateBackupMetadata(value) {
  const manifest = /** @type {import('./files.mjs').Manifest} */ (value);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    fail('Invalid backup metadata.');
  if (
    typeof manifest.gitCommit !== 'string' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.gitCommit)
  )
    fail('Invalid source Git revision.');
  for (const version of [manifest.mongoVersion, manifest.toolsVersion])
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version))
      fail('Invalid backup version.');
  if (
    !Number.isInteger(manifest.mongoPort) ||
    manifest.mongoPort < 1024 ||
    manifest.mongoPort > 65535
  )
    fail('Invalid backup MongoDB port.');
  if (
    typeof manifest.mongoEnv !== 'string' ||
    !manifest.mongoEnv ||
    path.isAbsolute(manifest.mongoEnv) ||
    /[\0\r\n]/.test(manifest.mongoEnv) ||
    manifest.mongoEnv.split('/').some((part) => ['..', '.', '.git', ''].includes(part))
  )
    fail('Invalid backup env path.');
  if (
    !Array.isArray(manifest.databases) ||
    !manifest.databases.length ||
    new Set(manifest.databases).size !== manifest.databases.length ||
    manifest.databases.some(
      (name) =>
        typeof name !== 'string' ||
        !/^[A-Za-z0-9_-]{1,63}$/.test(name) ||
        ['admin', 'config', 'local'].includes(name),
    )
  )
    fail('Invalid backup database list.');
  return manifest;
}
