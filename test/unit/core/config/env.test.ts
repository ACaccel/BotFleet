import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvLoadError, loadEnv, readNpmConfigFlags } from '../../../../src/core/config/env';
import { captureStderrNdjson } from '../../../support/ndjson';

const validBase = {
  TOKEN: 'real-bot-token-value-xyz',
  CLIENT_ID: '123456789012345678',
  MONGO_URI: 'mongodb://db.example.com:27017',
  NODE_ENV: 'test',
} satisfies NodeJS.ProcessEnv;

describe('loadEnv', () => {
  // Every test captures stderr so the NDJSON written by handleFailure
  // does not leak into the test runner's output. Tests that need to
  // assert on the captured lines read from this handle directly.
  let stderrCapture: ReturnType<typeof captureStderrNdjson>;

  beforeEach(() => {
    stderrCapture = captureStderrNdjson();
  });

  afterEach(() => {
    stderrCapture.restore();
    vi.restoreAllMocks();
  });

  it('validates the recovery interval and supplies its default', () => {
    expect(loadEnv({ exitOnFailure: false, source: validBase }).MONGO_RECOVERY_INTERVAL_MS).toBe(
      60_000,
    );
    expect(
      loadEnv({
        exitOnFailure: false,
        source: { ...validBase, MONGO_RECOVERY_INTERVAL_MS: '5000' },
      }).MONGO_RECOVERY_INTERVAL_MS,
    ).toBe(5000);
    for (const value of ['0', '-1', '1.5', 'invalid', '2147483648']) {
      expect(() =>
        loadEnv({
          exitOnFailure: false,
          source: { ...validBase, MONGO_RECOVERY_INTERVAL_MS: value },
        }),
      ).toThrow(EnvLoadError);
    }
  });

  it('accepts only absolute deployment readiness paths', () => {
    expect(
      loadEnv({
        exitOnFailure: false,
        source: {
          ...validBase,
          BOTFLEET_READY_FILE: '/run/botfleet/ready.json',
        },
      }).BOTFLEET_READY_FILE,
    ).toBe('/run/botfleet/ready.json');
    for (const value of ['', 'ready.json']) {
      expect(() =>
        loadEnv({
          exitOnFailure: false,
          source: {
            ...validBase,
            BOTFLEET_READY_FILE: value,
          },
        }),
      ).toThrow(EnvLoadError);
    }
  });

  describe('success paths', () => {
    it('parses a valid environment and returns a frozen object', () => {
      const env = loadEnv({ exitOnFailure: false, source: { ...validBase } });
      expect(env.TOKEN).toBe('real-bot-token-value-xyz');
      expect(env.CLIENT_ID).toBe('123456789012345678');
      expect(env.MONGO_URI).toBe('mongodb://db.example.com:27017');
      expect(env.NODE_ENV).toBe('test');
      expect(env.LOG_LEVEL).toBe('info');
      expect(Object.isFrozen(env)).toBe(true);
    });

    it('coerces PORT from a string', () => {
      const env = loadEnv({
        exitOnFailure: false,
        requireDb: false,
        source: { ...validBase, MONGO_URI: undefined, PORT: '8080' },
      });
      expect(env.PORT).toBe(8080);
    });

    it('accepts mongodb+srv:// scheme', () => {
      const env = loadEnv({
        exitOnFailure: false,
        source: { ...validBase, MONGO_URI: 'mongodb+srv://cluster.example.com/db' },
      });
      expect(env.MONGO_URI).toBe('mongodb+srv://cluster.example.com/db');
    });

    it('strips unknown env vars from the returned object', () => {
      const env = loadEnv({
        exitOnFailure: false,
        source: { ...validBase, RANDOM_THING: 'leak-me' } as NodeJS.ProcessEnv,
      });
      expect((env as Record<string, unknown>)['RANDOM_THING']).toBeUndefined();
    });

    it('treats empty LLM API keys as absent (operators leave unused providers blank)', () => {
      // Konata-style .env: declares every provider key but only fills xAI.
      const env = loadEnv({
        exitOnFailure: false,
        source: {
          ...validBase,
          OPENAI_API_KEY: '',
          ANTHROPIC_API_KEY: '   ',
          GEMINI_API_KEY: '',
          XAI_API_KEY: 'real-xai-key',
        },
      });
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.GEMINI_API_KEY).toBeUndefined();
      expect(env.XAI_API_KEY).toBe('real-xai-key');
    });

    it('carries CWA_API_KEY through and treats a blank one as absent', () => {
      // nijika's .env may keep the line blank to leave report polling off.
      const withKey = loadEnv({
        exitOnFailure: false,
        source: { ...validBase, CWA_API_KEY: 'CWA-0000-test' },
      });
      expect(withKey.CWA_API_KEY).toBe('CWA-0000-test');
      for (const blank of ['', '   ']) {
        const env = loadEnv({ exitOnFailure: false, source: { ...validBase, CWA_API_KEY: blank } });
        expect(env.CWA_API_KEY).toBeUndefined();
        expect('CWA_API_KEY' in env).toBe(false);
      }
      expect(loadEnv({ exitOnFailure: false, source: validBase }).CWA_API_KEY).toBeUndefined();
    });
  });

  describe('failure paths', () => {
    it('aggregates every base-schema issue, not just the first', () => {
      expect(() => loadEnv({ exitOnFailure: false, source: {} })).toThrow(EnvLoadError);
      try {
        loadEnv({ exitOnFailure: false, source: {} });
      } catch (err) {
        expect(err).toBeInstanceOf(EnvLoadError);
        const paths = (err as EnvLoadError).issues.map((i) => i.path.join('.'));
        // TOKEN and CLIENT_ID failures are surfaced together. (zod's
        // superRefine for MONGO_URI runs only after base validation
        // succeeds, so it does not appear in this batch — its branch is
        // covered by the "requireDb" test below.)
        expect(paths).toEqual(expect.arrayContaining(['TOKEN', 'CLIENT_ID']));
        expect(paths.length).toBeGreaterThanOrEqual(2);
      }
    });

    it('surfaces the requireDb superRefine issue when base schema passes', () => {
      expect(() =>
        loadEnv({
          exitOnFailure: false,
          source: { ...validBase, MONGO_URI: undefined },
        }),
      ).toThrow(EnvLoadError);
      try {
        loadEnv({
          exitOnFailure: false,
          source: { ...validBase, MONGO_URI: undefined },
        });
      } catch (err) {
        const paths = (err as EnvLoadError).issues.map((i) => i.path.join('.'));
        expect(paths).toContain('MONGO_URI');
      }
    });

    it('rejects a TOKEN containing a placeholder substring', () => {
      expect(() =>
        loadEnv({
          exitOnFailure: false,
          source: { ...validBase, TOKEN: 'MTk4_your_token_here' },
        }),
      ).toThrow(EnvLoadError);
    });

    it('rejects mongodb URI without a host', () => {
      expect(() =>
        loadEnv({
          exitOnFailure: false,
          source: { ...validBase, MONGO_URI: 'mongodb://' },
        }),
      ).toThrow(EnvLoadError);
    });

    it('rejects mongodb URI with the wrong scheme', () => {
      expect(() =>
        loadEnv({
          exitOnFailure: false,
          source: { ...validBase, MONGO_URI: 'http://example.com' },
        }),
      ).toThrow(EnvLoadError);
    });

    it('rejects when requirePort=true but PORT is missing', () => {
      expect(() =>
        loadEnv({
          exitOnFailure: false,
          requirePort: true,
          source: { ...validBase },
        }),
      ).toThrow(EnvLoadError);
    });

    it('emits an NDJSON failure record to stderr before throwing', () => {
      expect(() => loadEnv({ exitOnFailure: false, source: {} })).toThrow(EnvLoadError);
      const lines = stderrCapture.lines();
      expect(lines.some((l) => l.event === 'env_load_failed' && l.level === 60)).toBe(true);
    });

    it('fails fast when an explicit envFile path does not exist', () => {
      // The dotenv branch must report a structured envFile issue rather
      // than falling through to "TOKEN missing" — otherwise a misnamed
      // env path looks like an env-content bug to operators.
      expect(() =>
        loadEnv({
          exitOnFailure: false,
          envFile: '/tmp/botfleet-no-such-file.env',
        }),
      ).toThrow(EnvLoadError);
      const issues = stderrCapture
        .lines()
        .flatMap((l) => (Array.isArray(l['issues']) ? l['issues'] : []));
      expect(issues.some((i) => (i as { path?: string }).path === 'envFile')).toBe(true);
    });
  });

  describe('LOG_RETENTION_DAYS', () => {
    const days = (value: string | undefined): number =>
      loadEnv({
        exitOnFailure: false,
        source: { ...validBase, ...(value === undefined ? {} : { LOG_RETENTION_DAYS: value }) },
      }).LOG_RETENTION_DAYS;

    it('defaults to 60 days', () => {
      expect(days(undefined)).toBe(60);
    });

    it('accepts a positive count and 0 (disabled)', () => {
      expect(days('14')).toBe(14);
      expect(days('0')).toBe(0);
    });

    it('fails startup on blank, negative, fractional or non-numeric values', () => {
      for (const bad of ['', ' ', '-1', '1.5', 'abc', '1e2', '99999']) {
        expect(() => days(bad), bad).toThrow(EnvLoadError);
      }
    });
  });

  describe('production + debug warning', () => {
    it('writes a warn NDJSON line when NODE_ENV=production and LOG_LEVEL=debug', () => {
      const env = loadEnv({
        exitOnFailure: false,
        source: { ...validBase, NODE_ENV: 'production', LOG_LEVEL: 'debug' },
      });
      expect(env.LOG_LEVEL).toBe('debug');
      const lines = stderrCapture.lines();
      expect(
        lines.some((l) => l.event === 'env_loaded_with_debug_in_production' && l.level === 40),
      ).toBe(true);
    });
  });

  describe('exit-on-failure guard', () => {
    it('calls process.exit(1) when exitOnFailure=true', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
        throw new Error(`__test_exit:${code}`);
      }) as never);

      expect(() => loadEnv({ exitOnFailure: true, source: {} })).toThrow('__test_exit:1');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});

describe('readNpmConfigFlags', () => {
  it('maps kebab-case flags to their npm_config_ variables and omits unset ones', () => {
    const flags = readNpmConfigFlags(['t', 'dry-run', 'dev-guild', 'keep-guild-commands'], {
      npm_config_t: 'true',
      npm_config_dry_run: 'true',
      npm_config_dev_guild: '123456789012345678',
      npm_config_unrelated: 'x',
    });

    expect(flags).toEqual({ t: 'true', 'dry-run': 'true', 'dev-guild': '123456789012345678' });
    expect(Object.isFrozen(flags)).toBe(true);
  });

  it('keeps an empty value npm set for a disabled flag', () => {
    expect(readNpmConfigFlags(['dry-run'], { npm_config_dry_run: '' })).toEqual({ 'dry-run': '' });
  });
});
