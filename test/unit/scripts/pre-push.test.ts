import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const checks = [
  'typecheck',
  'typecheck:emit',
  'lint',
  'format:check',
  'handlers:gen:check',
  'test:coverage',
  'knip',
  'security',
];

describe('pre-push hook', () => {
  it('isolates gate subprocesses from the pushed repository Git environment', () => {
    const root = mkdtempSync(join(tmpdir(), 'botfleet-pre-push-'));
    try {
      const repo = join(root, 'repository');
      const bin = join(root, 'bin');
      const log = join(root, 'checks.jsonl');
      const childRepo = join(root, 'gate-repository');
      mkdirSync(repo);
      mkdirSync(bin);
      const localVariables = execFileSync('git', ['rev-parse', '--local-env-vars'], {
        encoding: 'utf8',
      })
        .trim()
        .split('\n');
      const env = { ...process.env };
      for (const name of localVariables) delete env[name];
      const git = (...args: string[]): string =>
        execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
      git('init', '--quiet');
      writeFileSync(join(repo, 'sentinel.txt'), 'original repository\n');
      git('add', 'sentinel.txt');
      git(
        '-c',
        'user.name=Test User',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '--quiet',
        '-m',
        'test: initialize repository',
      );
      const head = git('rev-parse', 'HEAD');
      const originalConfig = readFileSync(join(repo, '.git/config'), 'utf8');
      writeFileSync(
        join(bin, 'npm'),
        `#!${process.execPath}\n` +
          String.raw`const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
for (const name of JSON.parse(process.env.TEST_GIT_LOCAL_VARIABLES)) {
  if (Object.hasOwn(process.env, name)) throw new Error('Inherited Git variable: ' + name);
}
appendFileSync(process.env.TEST_GATE_LOG, JSON.stringify(process.argv.slice(2)) + '\n');
if (process.argv[3] === 'test:coverage') {
  const cwd = process.env.TEST_CHILD_REPO;
  mkdirSync(cwd);
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git('init', '--quiet');
  writeFileSync(join(cwd, 'child.txt'), 'independent repository\n');
  git('add', 'child.txt');
  git('-c', 'user.name=Test User', '-c', 'user.email=test@example.invalid',
      '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'test: child repository');
}
`,
        { mode: 0o755 },
      );
      const result = spawnSync('sh', [resolve('.githooks/pre-push')], {
        cwd: repo,
        encoding: 'utf8',
        input: `refs/heads/dev ${head} refs/heads/dev ${'0'.repeat(40)}\n`,
        env: {
          ...env,
          PATH: `${bin}:${env.PATH ?? ''}`,
          GIT_DIR: join(repo, '.git'),
          GIT_COMMON_DIR: join(repo, '.git'),
          GIT_WORK_TREE: repo,
          GIT_INDEX_FILE: join(repo, '.git/index'),
          GIT_PREFIX: '',
          TEST_GIT_LOCAL_VARIABLES: JSON.stringify(localVariables),
          TEST_GATE_LOG: log,
          TEST_CHILD_REPO: childRepo,
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(
        readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as string[]),
      ).toEqual(checks.map((check) => ['run', check]));
      expect(git('rev-parse', 'HEAD')).toBe(head);
      expect(git('status', '--porcelain')).toBe('');
      expect(readFileSync(join(repo, '.git/config'), 'utf8')).toBe(originalConfig);
      expect(readFileSync(join(repo, 'sentinel.txt'), 'utf8')).toBe('original repository\n');
      expect(
        execFileSync('git', ['log', '-1', '--format=%s'], {
          cwd: childRepo,
          env,
          encoding: 'utf8',
        }).trim(),
      ).toBe('test: child repository');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
