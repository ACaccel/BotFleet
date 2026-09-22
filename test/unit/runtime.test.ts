import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const launcher = resolve('scripts/runtime.mjs');
let prefix: string;

function run(...args: string[]) {
  return spawnSync(process.execPath, [launcher, ...args], {
    encoding: 'utf8',
    env: { ...process.env, BOTFLEET_CONDA_PREFIX: prefix, PATH: '/usr/bin:/bin' },
  });
}

beforeEach(() => {
  prefix = mkdtempSync(join(tmpdir(), 'botfleet-runtime-'));
  mkdirSync(join(prefix, 'bin'));
  mkdirSync(join(prefix, 'conda-meta'));
  mkdirSync(join(prefix, 'lib/node_modules/yarn/bin'), { recursive: true });
  writeFileSync(join(prefix, 'conda-meta/history'), 'fixture');
  symlinkSync(process.execPath, join(prefix, 'bin/node'));
  writeFileSync(join(prefix, 'lib/node_modules/yarn/bin/yarn.js'), "console.log('1.22.22');");
});
afterEach(() => rmSync(prefix, { recursive: true, force: true }));

describe('project runtime launcher', () => {
  it('selects the explicit prefix and sets child executable lookup paths', () => {
    const result = run(
      'exec',
      'node',
      '-e',
      'console.log(JSON.stringify([process.env.CONDA_PREFIX,process.env.PATH.split(":")[0],process.env.npm_node_execpath]))',
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      prefix,
      join(prefix, 'bin'),
      join(prefix, 'bin/node'),
    ]);
    expect(run('path').stdout.trim()).toBe(join(prefix, 'bin/node'));
  });

  it('refuses missing runtimes without using system Node', () => {
    rmSync(join(prefix, 'conda-meta/history'));
    const result = run('exec', 'node', '-e', 'process.exit(0)');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('runtime is missing');
  });

  it('refuses unsupported Node versions and unexpected activation hooks', () => {
    rmSync(join(prefix, 'bin/node'));
    writeFileSync(join(prefix, 'bin/node'), '#!/bin/sh\necho v18.20.0\n', { mode: 0o755 });
    expect(run('path').stderr).toContain('requires Node 22.13+');
    mkdirSync(join(prefix, 'etc/conda/activate.d'), { recursive: true });
    writeFileSync(join(prefix, 'etc/conda/activate.d/example.sh'), 'export EXAMPLE=1');
    expect(run('path').stderr).toContain('activation hooks');
  });

  it('preserves command exit status and rejects arbitrary external executables', () => {
    expect(run('exec', 'node', '-e', 'process.exit(17)').status).toBe(17);
    expect(run('exec', '/bin/true').stderr).toContain('executable is unavailable');
    expect(run('exec', 'missing-executable').status).toBe(1);
  });

  it('forwards termination to the child and waits for its shutdown', async () => {
    const ready = join(prefix, 'ready');
    const stopped = join(prefix, 'stopped');
    const script = `const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(stopped)},'stopped');process.exit(0)});fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, [launcher, 'exec', 'node', '-e', script], {
      env: { ...process.env, BOTFLEET_CONDA_PREFIX: prefix },
      stdio: 'ignore',
    });
    const closed = new Promise((resolveClose) => child.once('close', resolveClose));
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(ready) && Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
      expect(existsSync(ready)).toBe(true);
      child.kill('SIGTERM');
      expect(await closed).toBe(0);
      expect(existsSync(stopped)).toBe(true);
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
      await closed;
    }
  });
});
