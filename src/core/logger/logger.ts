/**
 * Structured logger built on pino.
 *
 *   - {@link Logger} is structurally compatible with pino's logger, so a pino
 *     instance satisfies it and tests can substitute an in-memory fake.
 *   - Redact paths come from `src/core/config/redact.ts`, shared with the
 *     env loader.
 *   - Child loggers compose bot → guild → interaction, with a `traceId`
 *     bound by the InteractionRouter. Do NOT use AsyncLocalStorage to
 *     propagate `traceId`; handlers receive their child logger via the
 *     interaction context.
 *   - `err()` also logs the DomainError JSON shape under `err`, so
 *     structured consumers see `kind`, `code`, `messageKey`, etc. alongside
 *     the stack and `cause`.
 *
 * The logger initialises after the env loader because it reads `LOG_LEVEL`
 * and `NODE_ENV`; see the `src/core/config/env.ts` header.
 */
import pino, {
  multistream,
  type Logger as PinoLogger,
  type LoggerOptions,
  type StreamEntry,
} from 'pino';
import { buildPinoRedactPaths } from '../config/redact';
import { scrubForLog, scrubUrlCredentials } from './scrub-for-log';

/**
 * Application-facing logger surface. A subset of pino's API — keeping
 * it small means tests can fake it without re-implementing pino.
 */
export interface Logger {
  trace(obj: object, msg?: string): void;
  trace(msg: string): void;
  debug(obj: object, msg?: string): void;
  debug(msg: string): void;
  info(obj: object, msg?: string): void;
  info(msg: string): void;
  warn(obj: object, msg?: string): void;
  warn(msg: string): void;
  error(obj: object, msg?: string): void;
  error(msg: string): void;
  fatal(obj: object, msg?: string): void;
  fatal(msg: string): void;
  /**
   * Create a child logger that automatically includes `bindings` on
   * every line. Used for scope propagation
   * (`root.child({ bot }).child({ guildId }).child({ traceId })`).
   */
  child(bindings: Readonly<Record<string, unknown>>): Logger;
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

interface CreateLoggerInput {
  /** pino level. Validated upstream by env schema. */
  readonly level: LogLevel;
  /** When true, route through pino-pretty for human-readable dev output. */
  readonly pretty: boolean;
  /** Bound on every line (e.g. `{ env: 'production', service: 'pleiades' }`). */
  readonly base?: Readonly<Record<string, unknown>>;
  /**
   * Additional pino multistream sinks layered on top of the (optional)
   * pretty console. Each entry filters by `level` independently. The
   * file-router transport lives behind {@link createFileSink} in the
   * sibling `file-router-transport` module — wire it through this
   * option from the composition root (`createBootstrapLogger` does this
   * for production). Leaving this empty (the default) yields a logger
   * with no file output, which is what unit tests want.
   */
  readonly extraStreams?: readonly StreamEntry[];
}

/**
 * Build the root logger for a process. Called exactly once per bot
 * process from `BaseBot.run()` (or test setup). Subsequent scope
 * narrowing happens via `.child()`.
 */
export const createLogger = (input: CreateLoggerInput): Logger => {
  const options: LoggerOptions = {
    level: input.level,
    base: input.base ?? null, // null = drop default { pid, hostname } noise
    redact: {
      paths: [...buildPinoRedactPaths()],
      remove: false, // mask with [Redacted] so absence is visible in logs
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  // Pretty + caller-supplied sinks (typically the file-router) are
  // stacked through `pino.multistream` rather than `transport.targets`.
  // Multistream keeps every sink in-process (no worker thread, no
  // `require.resolve` of a TypeScript entry point) which is what makes
  // the file router work cleanly under both `ts-node` and compiled JS.
  // Each entry filters by `level` independently so the pretty console
  // can stay at `info` while the file router captures `trace` for
  // later forensics.
  const streams: StreamEntry[] = [];
  // `silent` shortcircuits every sink — pino's own `level: 'silent'`
  // already drops the record before it reaches a stream, but we also
  // skip stream construction so a unit test running at `silent` does
  // not allocate a pretty stream or open a file descriptor.
  if (input.level !== 'silent') {
    const streamLevel = input.level;
    if (input.pretty) {
      // `pino-pretty` is dev-only and lazy-required so production
      // installs that prune dev deps do not crash at logger init.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const prettyStream = (require('pino-pretty') as (opts: object) => NodeJS.WritableStream)({
        colorize: true,
        // `SYS:` = system localtime (no `UTC:` prefix). Seconds-only —
        // the ms tail added too much visual noise in dev output.
        translateTime: 'SYS:HH:MM:ss',
        // `bot` / `guildId` / `eventType` are valuable in the JSON
        // file sink but redundant in the pretty console: the headline
        // already shows eventType, and a dev terminal is per-bot.
        ignore: 'pid,hostname,bot,guildId,eventType',
      });
      streams.push({ level: streamLevel, stream: prettyStream });
    }
    if (input.extraStreams !== undefined) {
      for (const entry of input.extraStreams) {
        streams.push(entry);
      }
    }
  }
  const root: PinoLogger = streams.length > 0 ? pino(options, multistream(streams)) : pino(options);
  return wrap(root);
};

/**
 * Adapt a pino logger to our {@link Logger} interface. Keeps the rest
 * of the codebase from importing pino types directly.
 *
 * Every object argument is passed through {@link scrubForLog} before
 * reaching pino. This is **redundant** with pino's `redact.paths`
 * (configured in {@link createLogger}) — it exists to give CodeQL's
 * taint analysis an explicit sanitisation step it can recognise on
 * `js/clear-text-logging`, AND as defense-in-depth against a future
 * redact-path misconfiguration. See `scrub-for-log.ts` header.
 */
const wrap = (p: PinoLogger): Logger => {
  type LogFn = (obj: object, msg?: string) => void;
  type StringLogFn = (msg: string) => void;
  const call =
    (objFn: LogFn, strFn: StringLogFn) =>
    (a: object | string, b?: string): void => {
      if (typeof a === 'string') {
        // A headline is a bare string, so the object walk never sees it.
        // `guild-db-connector` passes a failed Mongo open's message here
        // verbatim, and that message embeds the connection URI.
        strFn(scrubUrlCredentials(a));
        return;
      }
      // scrubForLog deep-clones with sensitive top-level + nested keys
      // replaced by '[Redacted]'. Pino's runtime redact still runs on
      // top of this; the scrub is the static-analysis-visible step.
      const scrubbed = scrubForLog(a) as object;
      objFn(scrubbed, b);
    };
  return {
    trace: call(p.trace.bind(p), p.trace.bind(p)),
    debug: call(p.debug.bind(p), p.debug.bind(p)),
    info: call(p.info.bind(p), p.info.bind(p)),
    warn: call(p.warn.bind(p), p.warn.bind(p)),
    error: call(p.error.bind(p), p.error.bind(p)),
    fatal: call(p.fatal.bind(p), p.fatal.bind(p)),
    child: (bindings) => wrap(p.child(bindings)),
  };
};
