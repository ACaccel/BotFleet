/**
 * Env key-closure contract.
 *
 * `loadEnv` projects the parsed environment onto the schema's own keys
 * so `.passthrough()` cannot leak unknown variables to callers. That
 * projection used to be a hand-written destructure, and it silently
 * dropped `ACCUWEATHER_KEY` — the key existed in the schema and in the
 * `Env` type, but never reached the returned object, so
 * `/weather_forecast` reported "service unavailable" on a correctly
 * configured deployment.
 *
 * The contract asserted here is closure in both directions: every key
 * the schema declares comes back out, and nothing else does.
 */
import { describe, expect, it } from 'vitest';

import { ENV_KEYS, loadEnv } from '../../../../src/core/config/env';

/**
 * A source populating every declared key with a schema-valid value.
 * Values are placeholder-free on purpose: the schema rejects the
 * obvious `your_token` / `changeme` forms.
 */
const FULL_SOURCE: NodeJS.ProcessEnv = {
  TOKEN: 'real-bot-token-value-xyz',
  CLIENT_ID: '123456789012345678',
  MONGO_URI: 'mongodb://db.internal:27017',
  MONGO_RECOVERY_INTERVAL_MS: '5000',
  PORT: '8080',
  NODE_ENV: 'test',
  LOG_LEVEL: 'warn',
  BOTFLEET_READY_FILE: '/run/botfleet-test/ready.json',
  OPENAI_API_KEY: 'sk-openai',
  ANTHROPIC_API_KEY: 'sk-anthropic',
  GEMINI_API_KEY: 'sk-gemini',
  XAI_API_KEY: 'sk-xai',
  ACCUWEATHER_KEY: 'accuweather-key',
  GOPHER_SETTINGS_API_KEY: 'gopher-bearer',
};

describe('Env key closure', () => {
  it('populates the fixture with every declared key', () => {
    // Guards the fixture itself: a key added to the schema without a
    // value here would make the closure assertion below vacuous.
    expect([...ENV_KEYS].sort()).toEqual(Object.keys(FULL_SOURCE).sort());
  });

  it('returns exactly the declared keys when every one is supplied', () => {
    const env = loadEnv({ exitOnFailure: false, source: { ...FULL_SOURCE } });
    expect(Object.keys(env).sort()).toEqual([...ENV_KEYS].sort());
  });

  it('carries ACCUWEATHER_KEY through to the result', () => {
    const env = loadEnv({ exitOnFailure: false, source: { ...FULL_SOURCE } });
    expect(env.ACCUWEATHER_KEY).toBe('accuweather-key');
  });

  it('drops keys the schema does not declare', () => {
    const env = loadEnv({
      exitOnFailure: false,
      source: { ...FULL_SOURCE, HOME: '/root', SOME_OTHER_TOOL_TOKEN: 'nope' },
    });
    expect(Object.keys(env).sort()).toEqual([...ENV_KEYS].sort());
  });
});
