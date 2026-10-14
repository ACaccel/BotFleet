/**
 * Logger built directly from `process.env` (`LOG_LEVEL`, `NODE_ENV`,
 * `LOG_DIR`, `LOG_RETENTION_DAYS`) for the window before `loadEnv()` runs.
 *
 * `BaseBot.run()` uses it as the lazy IoC Logger factory, which needs a
 * Logger before a typed `Env` exists. It validates the level, pretty-prints
 * outside production, and opts into the file sink via `createFileSink` so
 * `createLogger` stays free of file-system concerns. Tests build loggers
 * with `createLogger` directly and so never construct a file sink.
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
