import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prefix = process.env.BOTFLEET_CONDA_PREFIX || join(root, '.conda');
const node = join(prefix, 'bin', 'node');
const npm = join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');

function runtimeEnvironment() {
  const environment = { ...process.env };
  delete environment.NODE_PATH;
  delete environment.npm_config_prefix;
  delete environment.NPM_CONFIG_PREFIX;
  return {
    ...environment,
    PATH: [join(prefix, 'bin'), join(root, 'node_modules', '.bin'), environment.PATH || ''].join(
      delimiter,
    ),
    CONDA_PREFIX: prefix,
    npm_node_execpath: node,
    npm_execpath: npm,
  };
}

function requireRuntime() {
  if (!isAbsolute(prefix)) throw new Error('BOTFLEET_CONDA_PREFIX must be an absolute path.');
  if (!existsSync(join(prefix, 'conda-meta', 'history')) || !existsSync(node) || !existsSync(npm)) {
    throw new Error('Project Conda runtime is missing. Run bash scripts/setup-env.sh first.');
  }
  // The application definition uses only Node. Refuse silently skipping hooks if operators add packages.
  const hooks = join(prefix, 'etc', 'conda', 'activate.d');
  if (existsSync(hooks) && readdirSync(hooks).some((name) => name.endsWith('.sh'))) {
    throw new Error(
      'Project runtime has activation hooks; review them before using this launcher.',
    );
  }
  const version = spawnSync(node, ['--version'], { encoding: 'utf8', env: runtimeEnvironment() });
  const match = /^v22\.(\d+)\.\d+\s*$/.exec(version.stdout || '');
  const manager = spawnSync(node, [npm, '--version'], {
    encoding: 'utf8',
    env: runtimeEnvironment(),
  });
  if (
    version.status !== 0 ||
    !match ||
    Number(match[1]) < 13 ||
    manager.status !== 0 ||
    manager.stdout.trim() !== '10.9.2'
  ) {
    throw new Error(
      'Project runtime requires Node 22.13+ within 22 and npm 10.9.2. Run bash scripts/setup-env.sh.',
    );
  }
}

async function main(args) {
  const [action, command, ...rest] = args;
  if (action === 'setup') {
    const result = spawnSync('bash', [join(root, 'scripts', 'setup-env.sh')], {
      cwd: root,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    return;
  }
  if (!['path', 'exec'].includes(action) || (action === 'exec' && !command)) {
    throw new Error('Usage: node scripts/runtime.mjs setup | path | exec <command> [args]');
  }
  requireRuntime();
  if (action === 'path') {
    process.stdout.write(`${node}\n`);
    return;
  }
  const executable =
    command === 'node'
      ? node
      : command === 'npm'
        ? node
        : join(root, 'node_modules', '.bin', command);
  if (
    command !== 'node' &&
    command !== 'npm' &&
    (!/^[a-zA-Z0-9_-]+$/.test(command) || !existsSync(executable))
  ) {
    throw new Error(`Project executable is unavailable: ${command}`);
  }
  const childArgs = command === 'npm' ? [npm, ...rest] : rest;
  const detached = process.platform !== 'win32' && !process.stdin.isTTY;
  const child = spawn(executable, childArgs, {
    cwd: root,
    env: runtimeEnvironment(),
    stdio: 'inherit',
    detached,
  });
  const forward = (signal) => {
    if (!child.pid || child.exitCode !== null) return;
    try {
      if (detached) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  const onInt = () => forward('SIGINT');
  const onTerm = () => forward('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  try {
    await new Promise((resolvePromise, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143);
        resolvePromise();
      });
    });
  } finally {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
