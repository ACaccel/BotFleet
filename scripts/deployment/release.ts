import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import { loadEnv } from '../../src/core/config/env';
import {
  deploymentSchema,
  botService,
  mongoService,
  type DeploymentConfig,
  type Release,
} from './config';
import { botUnit, mongoUnit } from './units';
import { run, atomic } from './host';

export function readConfig(root: string): DeploymentConfig {
  const configFile = join(root, 'deployment.json');
  if (!existsSync(configFile))
    throw new Error(
      'Copy deployment.example.json to deployment.json and configure this host first',
    );
  const config = deploymentSchema.parse(JSON.parse(readFileSync(configFile, 'utf8')));
  if (config.user !== userInfo().username || process.getuid?.() === 0)
    throw new Error(
      'Run deployment as the configured ordinary service user; only system operations use sudo',
    );
  return config;
}
export function validatePrefix(prefix: string, executable: string): void {
  if (
    !existsSync(join(prefix, 'conda-meta/history')) ||
    !existsSync(join(prefix, 'bin', executable))
  )
    throw new Error(`Missing Conda runtime at ${prefix}; run its setup script`);
  const hooks = join(prefix, 'etc/conda/activate.d');
  if (existsSync(hooks) && readdirSync(hooks).some((name) => name.endsWith('.sh')))
    throw new Error(`Conda activation hooks require an explicit service launcher: ${hooks}`);
}
function localFiles(root: string, release: string): void {
  // Git identifies ignored operational files without copying unrelated home-directory state.
  const ignored = run(
    'git',
    ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', 'src'],
    { cwd: root },
  )
    .split('\0')
    .filter(Boolean);
  for (const file of ignored) {
    const source = resolve(root, file);
    const destination = resolve(release, file);
    if (!source.startsWith(`${root}/src/`) || !destination.startsWith(`${release}/src/`))
      throw new Error('Invalid local runtime file');
    if (!lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink())
      throw new Error('Unsupported local runtime file');
    mkdirSync(dirname(destination), { recursive: true });
    rmSync(destination, { force: true });
    symlinkSync(source, destination);
  }
  for (const name of ['data', 'logs', 'errors']) {
    const source = join(root, name);
    mkdirSync(source, { recursive: true });
    symlinkSync(source, join(release, name));
  }
}
export function makeRelease(root: string, config: DeploymentConfig, mongodbOnly: boolean): Release {
  const prefix = realpathSync(
    config.runtimePrefix ?? resolve(process.env.BOTFLEET_CONDA_PREFIX ?? join(root, '.conda')),
  );
  validatePrefix(prefix, 'node');
  const version = run(join(prefix, 'bin/node'), ['--version']).trim();
  if (!/^v22\.(?:1[3-9]|[2-9]\d|\d{3,})\./.test(version))
    throw new Error('Deployment requires Node 22.13+ within Node 22');
  const directory = join(root, '.deploy/releases', `${Date.now()}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const release: Release = { root, directory, prefix, config, units: {} };
  try {
    if (mongodbOnly) {
      if (!config.mongodb) throw new Error('Configure mongodb before preparing its service');
      validatePrefix(config.mongodb.prefix, 'mongod');
      const version = run(join(config.mongodb.prefix, 'bin/mongod'), ['--version']);
      if (!/db version v7\.0\.34(?:\s|$)/.test(version))
        throw new Error('MongoDB cutover requires version 7.0.34');
      const original = JSON.parse(readFileSync(config.mongodb.configFile, 'utf8')) as Record<
        string,
        unknown
      >;
      const management = original.processManagement;
      if (management && (typeof management !== 'object' || Array.isArray(management)))
        throw new Error('Invalid MongoDB processManagement configuration');
      const next = { ...original, processManagement: { ...(management as object), fork: false } };
      delete (next.processManagement as Record<string, unknown>).pidFilePath;
      const storage = original.storage as { dbPath?: string } | undefined;
      if (
        !storage?.dbPath ||
        !isAbsolute(storage.dbPath) ||
        !existsSync(storage.dbPath) ||
        !lstatSync(storage.dbPath).isDirectory()
      )
        throw new Error(
          'Existing MongoDB dbPath is required; preparation never creates a replacement database',
        );
      const configPath = join(directory, 'mongod.conf');
      atomic(configPath, JSON.stringify(next, null, 2) + '\n');
      atomic(
        join(directory, 'mongod.original.conf'),
        readFileSync(config.mongodb.configFile, 'utf8'),
      );
      release.units[mongoService] = mongoUnit(release, configPath);
    } else {
      for (const bot of config.bots) {
        const file = join(root, 'src/bot', bot, '.env');
        if (!existsSync(file)) throw new Error(`Missing local env for ${bot}`);
        loadEnv({
          source: parse(readFileSync(file)),
          requireDb: bot !== 'gopher',
          requirePort: ['nijika', 'gopher'].includes(bot),
          exitOnFailure: false,
        });
        if (!existsSync(join(root, 'src/bot', bot, 'config.json')))
          throw new Error(`Missing config.json for ${bot}`);
      }
      cpSync(join(root, 'src'), join(directory, 'src'), { recursive: true, dereference: false });
      for (const name of ['package.json', 'package-lock.json', 'tsconfig.json'])
        cpSync(join(root, name), join(directory, name));
      cpSync(join(root, 'scripts/mongo-ready.ts'), join(directory, 'scripts/mongo-ready.ts'), {
        recursive: true,
      });
      mkdirSync(join(directory, 'scripts/deployment'), { recursive: true });
      cpSync(
        join(root, 'scripts/deployment/mongo-probe.ts'),
        join(directory, 'scripts/deployment/mongo-probe.ts'),
      );
      run('cp', [
        '-a',
        '--reflink=auto',
        '--',
        join(root, 'node_modules'),
        join(directory, 'node_modules'),
      ]);
      localFiles(root, directory);
      run(
        join(prefix, 'bin/node'),
        [
          '-e',
          "require('canvas').createCanvas(1,1).toBuffer(); require('ts-node'); require('tsconfig-paths'); require('./src/i18n/locales/en/commands.json')",
        ],
        { cwd: directory },
      );
      for (const bot of config.bots) {
        const values = parse(readFileSync(join(directory, 'src/bot', bot, '.env')));
        release.units[botService(bot)] = botUnit(release, bot, Boolean(values.MONGO_URI));
      }
    }
    for (const [name, content] of Object.entries(release.units))
      writeFileSync(join(directory, name), content, { mode: 0o600 });
    run(
      'systemd-analyze',
      ['verify', ...Object.keys(release.units).map((name) => join(directory, name))],
      { quiet: false },
    );
    atomic(join(directory, 'manifest.json'), JSON.stringify(release, null, 2) + '\n');
    return release;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
export function assertNoUnmanagedProcesses(
  root: string,
  bots: readonly string[],
  managedPids: readonly number[],
  mongoPrefix?: string,
): void {
  for (const name of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    const pid = Number(name);
    if (managedPids.includes(pid)) continue;
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (!args[0]) continue;
      if (mongoPrefix && args[0].endsWith('/mongod'))
        throw new Error(
          `Unmanaged MongoDB process ${pid} is running; stop it cleanly before database cutover`,
        );
      if (
        (args[0] === 'node' || args[0].endsWith('/node')) &&
        bots.some((bot) =>
          args.some(
            (arg) =>
              arg === `src/bot/${bot}/index.ts` || arg === join(root, 'src/bot', bot, 'index.ts'),
          ),
        )
      )
        throw new Error(`Unmanaged bot process ${pid} is running; stop it before deployment`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Unmanaged')) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(code ?? '')) throw error;
    }
  }
}
export function relativeRelease(root: string, release: Release): string {
  return relative(root, release.directory);
}
