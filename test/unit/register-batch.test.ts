/**
 * Unit tests for the register CLI's bot discovery and batch runner.
 *
 * `npm run register` without a target registers every configured bot.
 * These pin which `src/bot/` directories count as configured, and that
 * one bot failing neither stops the remaining bots nor lets the run exit
 * 0.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runForEachBot, scanBotDirectories } from '../../src/register-batch';

describe('scanBotDirectories', () => {
  let root: string;

  const makeBot = (name: string, files: readonly string[]): void => {
    fs.mkdirSync(path.join(root, name));
    for (const file of files) fs.writeFileSync(path.join(root, name, file), '');
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'register-bots-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('splits personalities into configured and skipped, sorted by name', () => {
    makeBot('tomori', ['index.ts', 'config.json', '.env']);
    makeBot('konata', ['index.ts', 'config.json', '.env']);
    makeBot('gopher', ['index.ts', 'config.json']);
    makeBot('nijika', ['index.js', '.env']);
    makeBot('fresh', ['index.ts', 'config.example.json']);

    expect(scanBotDirectories(root)).toEqual({
      known: ['fresh', 'gopher', 'konata', 'nijika', 'tomori'],
      configured: ['konata', 'tomori'],
      skipped: [
        { bot: 'fresh', missing: ['config.json', '.env'] },
        { bot: 'gopher', missing: ['.env'] },
        { bot: 'nijika', missing: ['config.json'] },
      ],
    });
  });

  it('ignores plain files and directories without an entry module', () => {
    fs.writeFileSync(path.join(root, 'bootstrap.ts'), '');
    makeBot('shared', ['config.json', '.env']);
    makeBot('konata', ['index.ts', 'config.json', '.env']);

    expect(scanBotDirectories(root)).toEqual({
      known: ['konata'],
      configured: ['konata'],
      skipped: [],
    });
  });
});

describe('runForEachBot', () => {
  it('runs every bot in order and exits 0 when all succeed', async () => {
    const run = vi.fn(async () => undefined);
    const result = await runForEachBot(['a', 'b'], run);

    expect(run.mock.calls).toEqual([['a'], ['b']]);
    expect(result).toEqual({
      outcomes: [
        { bot: 'a', ok: true },
        { bot: 'b', ok: true },
      ],
      exitCode: 0,
    });
  });

  it('continues after one bot fails and exits 1', async () => {
    const failure = new Error('TOKEN is required');
    const run = vi.fn(async (bot: string) => {
      if (bot === 'konata') throw failure;
    });
    const onFailure = vi.fn();

    const result = await runForEachBot(['gopher', 'konata', 'nijika'], run, onFailure);

    expect(run).toHaveBeenCalledTimes(3);
    expect(onFailure).toHaveBeenCalledExactlyOnceWith('konata', failure);
    expect(result).toEqual({
      outcomes: [
        { bot: 'gopher', ok: true },
        { bot: 'konata', ok: false, error: failure },
        { bot: 'nijika', ok: true },
      ],
      exitCode: 1,
    });
  });

  it('runs bots sequentially, never overlapping', async () => {
    let active = 0;
    let maxActive = 0;
    const run = async (): Promise<void> => {
      active++;
      maxActive = Math.max(maxActive, active);
      // One event-loop turn: any run started concurrently would enter
      // before this one resumes.
      await new Promise((resolve) => setImmediate(resolve));
      active--;
    };

    await runForEachBot(['a', 'b', 'c'], run);
    expect(maxActive).toBe(1);
  });

  it('wraps a non-Error rejection', async () => {
    const result = await runForEachBot(['a'], () => Promise.reject('boom'));
    const [outcome] = result.outcomes;

    expect(result.exitCode).toBe(1);
    expect(outcome?.ok).toBe(false);
    if (outcome?.ok === false) expect(outcome.error.message).toBe('boom');
  });

  it('exits 0 for an empty batch', async () => {
    expect(await runForEachBot([], vi.fn())).toEqual({ outcomes: [], exitCode: 0 });
  });
});
