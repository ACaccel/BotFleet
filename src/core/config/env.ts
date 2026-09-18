/**
 * Environment variable schema and loader for a single bot process.
 *
 * Each bot is launched as its own Node process and reads its own `.env`
 * file (e.g. `src/bot/nijika/.env`). This module is the single typed
 * entry point — call `loadEnv()` once during startup; failure is fatal
 * and exits with a listing of every missing/invalid key (fail-fast).
 *
 * Bootstrap-circularity note: this module intentionally writes errors to
 * `process.stderr.write` rather than going through the structured logger.
 * The logger depends on LOG_LEVEL (loaded here), so logger initialisation
 * cannot precede env loading. Do not "fix" this by importing the logger.
 *
 * Security note: never log the parsed object directly. Use the redacting
 * logger (which honours REDACT_FIELD_NAMES in `./redact.ts`) for any
 * downstream observation. The parsed return value is frozen so callers
 * cannot mutate it into something a redactor would not catch.
 *
 * Reserved env-var prefixes:
 *   - `INTEGRATION_*` is owned by `test/integration/setup.ts` (e.g.
 *     `INTEGRATION_MONGO_URI` published by the mongodb-memory-server
 *     globalSetup). Do not promote any `INTEGRATION_*` key into this
 *     schema; tests own that namespace.
 */
import { z } from 'zod';
import * as dotenv from 'dotenv';
import * as path from 'path';

/**
 * Regex matched against TOKEN and CLIENT_ID values — substring match,
 * case-insensitive, so a leaked placeholder like
 * `MTk4...your_token_here` is rejected, not only the exact string
 * `your_token`.
 *
 * Exported so test suites and a future "scan all bot env files" tool can
 * reuse the same definition without drifting.
 */
const PLACEHOLDER_TOKEN_PATTERN =
  /(your[_-]?(token|client[_-]?id|secret)|xxx{2,}|changeme|placeholder|example|todo)/i;

const nonPlaceholder = (label: string) =>
  z
    .string()
    .min(1, `${label} is required`)
    .refine(
      (v) => !PLACEHOLDER_TOKEN_PATTERN.test(v),
      `${label} contains a placeholder substring (e.g. "your_token", "changeme")`,
    );

const mongoUriSchema = z
  .string()
  .refine(
    (v) => v.startsWith('mongodb://') || v.startsWith('mongodb+srv://'),
    'MONGO_URI must use the mongodb:// or mongodb+srv:// scheme',
  )
  .refine((v) => {
    try {
      return new URL(v).hostname.length > 0;
    } catch {
      return false;
    }
  }, 'MONGO_URI must include a non-empty host');

// Optional LLM-provider API keys. These live in the typed Env so the
// `infra/llm` providers resolve them through DI rather than reading
// `process.env` directly. A bot that does not use a given provider
// simply omits the key — the registry's missing-key gate at
// `resolve(name)` time emits a `MissingApiKeyError` which surfaces
// only when something actually asks for that provider.
//
// Treat empty / whitespace-only values as absent. Operators frequently
// keep one .env template per repo with every provider key listed and
// fill in only the ones they use (e.g. Konata uses xAI, leaves
// OPENAI_API_KEY=, ANTHROPIC_API_KEY=, GEMINI_API_KEY= blank). Without
// this preprocess the empty string survives into `.min(1)` and
// `loadEnv` rejects an otherwise-valid deployment.
const llmKeySchema = z.preprocess(
  (v) => (typeof v === 'string' && v.trim().length === 0 ? undefined : v),
  z.string().min(1).optional(),
);

/**
 * The typed environment contract, as a zod shape.
 *
 * `Env` is derived from this rather than restated: a hand-written type
 * beside a hand-written destructure is exactly how `ACCUWEATHER_KEY`
 * came to exist in both the schema and the type while never reaching
 * the returned object, silently disabling `/weather_forecast` on every
 * deployment. Adding a key here now updates the type, the runtime
 * projection, and the contract test at once.
 */
const envShape = {
  TOKEN: nonPlaceholder('TOKEN'),
  CLIENT_ID: nonPlaceholder('CLIENT_ID'),
  MONGO_URI: mongoUriSchema.optional(),
  /** Cooldown and polling interval for transient per-guild connection failures. */
  MONGO_RECOVERY_INTERVAL_MS: z.coerce.number().int().positive().max(2_147_483_647).default(60_000),
  /** HTTP port for the earthquake webhook (nijika) / settings API (gopher). */
  PORT: z.coerce.number().int().positive().optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  /** Optional per-provider LLM API keys. Absent when the deployment does not use that provider. */
  OPENAI_API_KEY: llmKeySchema,
  ANTHROPIC_API_KEY: llmKeySchema,
  GEMINI_API_KEY: llmKeySchema,
  XAI_API_KEY: llmKeySchema,
  /** AccuWeather API key. Optional — only required for the weather_forecast slash command. */
  ACCUWEATHER_KEY: z.string().min(1).optional(),
  /**
   * Bearer key for gopher's settings REST API. Optional — only gopher
   * sets it; the settings-api plugin refuses to start (when enabled)
   * without it, so a secret never lives in config.json.
   */
  GOPHER_SETTINGS_API_KEY: z.string().min(1).optional(),
} as const;

const envSchema = z
  .object(envShape)
  // Allow unknown env vars (Node, OS, shell tooling all add their own) but
  // only the typed keys above are returned to callers.
  .passthrough();

export type Env = Readonly<z.infer<z.ZodObject<typeof envShape>>>;

/**
 * Every typed key {@link loadEnv} carries through to its result.
 *
 * This is the projection `loadEnv` applies to strip the unknown keys
 * `.passthrough()` admits. Exported so the env contract test can assert
 * the closure at runtime, complementing the compile-time guarantee
 * `Env` gets from the same shape.
 */
export const ENV_KEYS: readonly (keyof Env)[] = Object.freeze(
  Object.keys(envShape) as (keyof Env)[],
);

/**
 * Structured aggregation of every zod validation failure for the parsed
 * environment, so a single failure prints all problems at once.
 */
export class EnvLoadError extends Error {
  public readonly issues: readonly z.ZodIssue[];

  public constructor(issues: readonly z.ZodIssue[]) {
    const summary = issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    super(`Environment validation failed:\n${summary}`);
    this.name = 'EnvLoadError';
    this.issues = issues;
  }
}

interface LoadEnvOptions {
  /**
   * Path to a `.env` file to load before parsing. Resolved relative to
   * `process.cwd()` if not absolute. Omit to read only `process.env`.
   * If the path is provided but the file cannot be read, this is a
   * configuration error and triggers fail-fast.
   */
  envFile?: string;
  /** Require MONGO_URI to be present and valid. Defaults to true. */
  requireDb?: boolean;
  /** Require PORT to be present and a positive integer. Defaults to false. */
  requirePort?: boolean;
  /** When true (default), validation failure exits the process. */
  exitOnFailure?: boolean;
  /** Override source object — primarily for unit tests. Defaults to process.env. */
  source?: NodeJS.ProcessEnv;
}

/**
 * Load and validate environment variables for the current bot process.
 *
 * @throws {EnvLoadError} when validation fails and `exitOnFailure` is false.
 * @returns a frozen {@link Env} containing only the typed, known keys.
 */
export const loadEnv = (options: LoadEnvOptions = {}): Env => {
  const { envFile, requireDb = true, requirePort = false, exitOnFailure = true, source } = options;

  if (envFile && !source) {
    const resolved = path.isAbsolute(envFile) ? envFile : path.resolve(process.cwd(), envFile);
    const result = dotenv.config({ path: resolved });
    if (result.error) {
      return handleFailure(
        [
          {
            code: z.ZodIssueCode.custom,
            path: ['envFile'],
            message: `Failed to load env file at ${resolved}: ${result.error.message}`,
          },
        ],
        exitOnFailure,
      );
    }
  }

  const schema = envSchema.superRefine((value, ctx) => {
    if (requireDb && value.MONGO_URI === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MONGO_URI'],
        message: 'MONGO_URI is required for this bot',
      });
    }
    if (requirePort && value.PORT === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PORT'],
        message: 'PORT is required for this bot',
      });
    }
  });

  const parseResult = schema.safeParse(source ?? process.env);
  if (!parseResult.success) {
    return handleFailure(parseResult.error.issues, exitOnFailure);
  }

  // Project onto the schema's own keys — this filters out the unknown
  // keys `.passthrough()` let into parseResult.data and keeps the
  // returned object narrow. (Do not "simplify" by spreading
  // parseResult.data; that would defeat the strip-unknown-keys guarantee
  // asserted in env.test.ts.) Absent optionals are omitted rather than
  // set to `undefined`, so `'KEY' in env` stays a meaningful test.
  const parsed = parseResult.data as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const key of ENV_KEYS) {
    const value = parsed[key];
    if (value !== undefined) projected[key] = value;
  }
  const env = Object.freeze(projected) as Env;

  if (env.NODE_ENV === 'production' && env.LOG_LEVEL === 'debug') {
    process.stderr.write(
      buildJsonLine('warn', 'env_loaded_with_debug_in_production', {
        message: 'LOG_LEVEL=debug in production may leak verbose data; consider info or warn.',
      }) + '\n',
    );
  }

  return env;
};

const handleFailure = (issues: readonly z.ZodIssue[], exitOnFailure: boolean): never => {
  const error = new EnvLoadError(issues);
  const payload = {
    issues: issues.map((i) => ({
      path: i.path.join('.') || '(root)',
      code: i.code,
      message: i.message,
    })),
  };

  process.stderr.write(buildJsonLine('fatal', 'env_load_failed', payload) + '\n');
  if (process.stderr.isTTY) {
    process.stderr.write(`\n${error.message}\n`);
  }

  if (exitOnFailure) {
    // Set exitCode before exit so any synchronous teardown sees the failure
    // state (process.exit alone bypasses pending microtasks but some
    // monitors read exitCode separately).
    process.exitCode = 1;
    process.exit(1);
  }
  throw error;
};

/**
 * Pino numeric level mapping. We emit numeric levels here so the
 * bootstrap NDJSON line is wire-compatible with downstream pino logs
 * and a single aggregator parser can read both.
 */
const PINO_LEVEL: Record<'fatal' | 'warn', number> = { fatal: 60, warn: 40 };

const buildJsonLine = (
  level: 'fatal' | 'warn',
  event: string,
  data: Record<string, unknown>,
): string =>
  JSON.stringify({
    level: PINO_LEVEL[level],
    levelLabel: level,
    event,
    pid: process.pid,
    time: Date.now(),
    ...data,
  });
