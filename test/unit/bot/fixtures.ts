import { afterEach, beforeEach, vi, type MockInstance } from 'vitest';

/**
 * Drop `loadEnv`'s `env_load_failed` NDJSON line for every test in the
 * calling file.
 *
 * `BaseBot.run()` loads the typed Env from `process.env`. Suites that
 * boot a bot without TOKEN / CLIENT_ID take the documented "Env
 * unbound" fallback on purpose, and `loadEnv` writes its fatal line
 * straight to stderr, where it reads like a real failure in the test
 * output. Every other stderr write still goes through.
 */
export const quietEnvLoadFailure = (): void => {
  let spy: MockInstance<typeof process.stderr.write> | undefined;
  beforeEach(() => {
    const write = process.stderr.write.bind(process.stderr) as (...args: unknown[]) => boolean;
    spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(((chunk: unknown, ...rest: unknown[]) =>
        typeof chunk === 'string' && chunk.includes('"event":"env_load_failed"')
          ? true
          : write(chunk, ...rest)) as typeof process.stderr.write);
  });
  afterEach(() => {
    spy?.mockRestore();
    spy = undefined;
  });
};
