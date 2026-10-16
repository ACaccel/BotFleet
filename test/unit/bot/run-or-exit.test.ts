/**
 * Startup-failure policy for the personality entry points.
 *
 * The contract under test is that a rejected `run()` terminates the
 * process instead of leaving a zombie with nothing registered.
 */
import { describe, expect, it } from 'vitest';

import { runOrExit } from '../../../src/bot/run-or-exit';
import { silentLogger } from '../../fixtures/runtime';

describe('runOrExit', () => {
  it('does not exit when startup succeeds', async () => {
    const exitCodes: number[] = [];
    let started = 0;

    await runOrExit(
      {
        run: async () => {
          started += 1;
        },
        logger: silentLogger(),
      },
      { exit: (code) => exitCodes.push(code) },
    );

    expect(started).toBe(1);
    expect(exitCodes).toEqual([]);
  });

  it('exits 1 when run() rejects', async () => {
    const exitCodes: number[] = [];

    await runOrExit(
      {
        run: async () => {
          throw new Error('login failed: invalid token');
        },
        logger: silentLogger(),
      },
      { exit: (code) => exitCodes.push(code) },
    );

    expect(exitCodes).toEqual([1]);
  });

  it('falls back to stderr when the failure precedes the logger binding', async () => {
    const exitCodes: number[] = [];
    const written: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      await runOrExit(
        {
          run: async () => {
            throw new Error('env validation failed');
          },
          logger: undefined,
        },
        { exit: (code) => exitCodes.push(code) },
      );
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(exitCodes).toEqual([1]);
    expect(written.join('')).toContain('env validation failed');
  });
});
