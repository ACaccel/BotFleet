/**
 * Bootstrap logger built directly from `process.env` reads.
 *
 * Lives under `src/core/config/**` so the `no-restricted-syntax` rule
 * that bans `process.env` reads outside `core/config` is satisfied
 * without an eslint-disable waiver. It:
 *
 *   - reads `LOG_LEVEL` / `NODE_ENV` / `LOG_DIR` / `LOG_RETENTION_DAYS`
 *   - validates the level against the typed allowlist
 *   - pretty-prints outside production
 *   - opts into the file-router sink via `createFileSink` (the
 *     composition-root factory in `core/logger/file-router-transport`),
 *     so `createLogger` itself stays free of file-system concerns
 *
 * Used as the lazy IoC Logger factory in `BaseBot.run()`: the factory
 * needs a Logger BEFORE `loadEnv()` runs, so a typed-Env-based logger
 * build is not possible at that point. This bootstrap exists precisely
 * to cover that pre-env window.
 *
 * Note on `NODE_ENV`: the historical `nodeEnv === 'test'` branch that
 * force-disabled the file sink is gone. Tests that need a logger build
 * one with `createLogger({ ... })` directly (no `extraStreams`) and
 * therefore never construct a file sink in the first place — the env
 * detection was dead-defensive code that bled the test environment
 * back into the production code path for no operational benefit.
 */
import { createFileSink, createLogger, type Logger, type LogLevel } from '../logger';
import { DEFAULT_LOG_RETENTION_DAYS, parseLogRetentionDays } from '../logger/log-retention';

const VALID_LEVELS = new Set<LogLevel>([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
  'silent',
]);

const parseLevel = (raw: string | undefined): LogLevel => {
  if (raw === undefined) return 'info';
  return VALID_LEVELS.has(raw as LogLevel) ? (raw as LogLevel) : 'info';
};

/**
 * Same fallback policy as {@link parseLevel}: this runs before
 * `loadEnv`, so it cannot fail the process itself. An invalid value
 * falls back to the default here and `loadEnv` rejects it at startup.
 */
const parseRetentionDays = (raw: string | undefined): number =>
  raw === undefined
    ? DEFAULT_LOG_RETENTION_DAYS
    : (parseLogRetentionDays(raw) ?? DEFAULT_LOG_RETENTION_DAYS);

interface BootstrapLoggerOptions {
  /**
   * When `false`, never attach the file-router sink — the logger writes
   * to the (pretty) console only. Default `true`. One-shot entry points
   * that are not a per-bot runtime (notably the `deploy` CLI) pass
   * `false`: they have no `bot` binding the file router requires, and
   * they should not create a `logs/<botId>/` tree.
   */
  readonly fileRouter?: boolean;
}

/**
 * Build a root {@link Logger} from `process.env.LOG_LEVEL` /
 * `process.env.NODE_ENV` / `process.env.LOG_DIR` /
 * `process.env.LOG_RETENTION_DAYS`. Pretty-print is
 * enabled outside production. The file-router sink is enabled whenever
 * `LOG_DIR` resolves to a non-empty string (default `'logs'`) — unless
 * the caller passes `{ fileRouter: false }` (or `LOG_DIR=''`) to force
 * console-only output for ephemeral / non-runtime callers that should
 * stay write-free and carry no `bot` binding.
 */
export const createBootstrapLogger = (
  base?: Readonly<Record<string, unknown>>,
  options?: BootstrapLoggerOptions,
): Logger => {
  const level = parseLevel(process.env.LOG_LEVEL);
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const fileRootDir = process.env.LOG_DIR ?? 'logs';
  const retentionDays = parseRetentionDays(process.env.LOG_RETENTION_DAYS);
  const fileRouterEnabled = options?.fileRouter ?? true;
  // `silent` short-circuits every sink inside `createLogger`, so
  // building a file sink that pino will never write to is a wasted fd.
  const extraStreams =
    fileRouterEnabled && fileRootDir.length > 0 && level !== 'silent'
      ? [createFileSink({ rootDir: fileRootDir, level, retentionDays })]
      : [];
  return createLogger({
    level,
    pretty: nodeEnv !== 'production',
    ...(base !== undefined ? { base } : {}),
    extraStreams,
  });
};
