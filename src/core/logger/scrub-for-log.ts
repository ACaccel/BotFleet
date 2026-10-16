/**
 * Defensive object scrubber applied before any value reaches pino.
 *
 * Pino's `redact.paths` already redacts the same field set at log time
 * (see `src/core/config/redact.ts`), so this scrubber is *redundant
 * with the runtime path*. It exists for two reasons:
 *
 *   1. CodeQL's `js/clear-text-logging` taint analysis cannot model
 *      pino's redact mechanism, so any value derived from a sensitive
 *      env access (e.g. `process.env[PROVIDER_API_KEY_ENV[...]]`)
 *      passed into the logger surface as a plain object would be
 *      flagged as a clear-text logging sink. Applying an explicit
 *      sanitisation step here ensures the static analyser sees the
 *      taint cleared before the pino call site.
 *   2. Defense in depth: a misconfigured pino instance (lost `redact`
 *      paths during a future refactor) would otherwise silently leak.
 *      This module is a second wall.
 *
 * The redact field list is sourced from `core/config/redact.ts` so the
 * scrubber, the pino redact paths, and the env loader all share one
 * authoritative banned-name list.
 *
 * Field-name redaction cannot reach a credential carried *inside* a
 * string — a URL such as `https://api.example/x?apikey=SECRET` is one
 * opaque value to both pino and the name-based walk. Some upstreams
 * accept the key only as a query parameter, so
 * {@link scrubUrlCredentials} strips those values from every string the
 * scrubber sees, including an `Error`'s message and stack.
 */
import { REDACT_FIELD_NAMES } from '../config/redact';

const SENSITIVE_NAMES_LOWER = new Set(REDACT_FIELD_NAMES.map((n) => n.toLowerCase()));
const REPLACEMENT = '[Redacted]';

/**
 * Query parameters whose value is a credential. Applied only to strings
 * that carry a URL scheme, so ordinary prose containing `key=` is left
 * alone. The longer alternatives come first: the group is anchored
 * immediately after `[?&]`, so `secret` would otherwise shadow
 * `client_secret`. `authorization` covers the CWA open-data API, which
 * takes its key as an `Authorization` query parameter.
 */
const SENSITIVE_QUERY_PARAM =
  /([?&])(client[_-]?secret|refresh[_-]?token|access[_-]?token|id[_-]?token|api[_-]?key|authorization|credential|signature|password|passwd|secret|token|auth|code|key|pwd|sig)=[^&\s"']*/gi;

/**
 * `scheme://user:password@host` — the shape `buildGuildMongoUri`
 * produces and that mongoose embeds verbatim in its
 * `MongoServerSelectionError` / `MongoParseError` messages. Field-name
 * redaction cannot reach inside that string.
 */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+:[^/\s@]+@/gi;

const looksLikeUrl = (value: string): boolean => value.includes('://');

/**
 * Replace credentials carried *inside* a URL string — both the
 * `user:password@` userinfo and credential-bearing query parameters.
 */
export const scrubUrlCredentials = (value: string): string => {
  if (!looksLikeUrl(value)) return value;
  return value
    .replace(URL_USERINFO, `$1${REPLACEMENT}@`)
    .replace(SENSITIVE_QUERY_PARAM, `$1$2=${REPLACEMENT}`);
};
/** Walk depth cap matches pino's depth coverage in buildPinoRedactPaths. */
const MAX_DEPTH = 4;

type Scalar = string | number | boolean | bigint | null | undefined;

const isPlainScalar = (v: unknown): v is Scalar =>
  v === null ||
  v === undefined ||
  typeof v === 'string' ||
  typeof v === 'number' ||
  typeof v === 'boolean' ||
  typeof v === 'bigint';

/**
 * Return a deep-cloned shape with values at keys in {@link REDACT_FIELD_NAMES}
 * (case-insensitive) replaced by `[Redacted]`. Error instances are
 * unwrapped into `{ name, message, code, stack, cause }` — `cause` is
 * recursed; ad-hoc Error fields (axios `config`, mongoose `requestPath`,
 * etc.) are dropped, eliminating the most common nested-secret carrier.
 */
export const scrubForLog = (value: unknown, depth = 0): unknown => {
  if (depth >= MAX_DEPTH) return REPLACEMENT;
  if (typeof value === 'string') return scrubUrlCredentials(value);
  if (isPlainScalar(value)) return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubUrlCredentials(value.message),
      stack: value.stack === undefined ? undefined : scrubUrlCredentials(value.stack),
      // `code` is common on Node / Mongoose / driver errors and is not
      // sensitive — preserve it for diagnostics.
      code: (value as Error & { code?: unknown }).code,
      cause: value.cause === undefined ? undefined : scrubForLog(value.cause, depth + 1),
    };
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrubForLog(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_NAMES_LOWER.has(k.toLowerCase())) {
        out[k] = REPLACEMENT;
        continue;
      }
      out[k] = scrubForLog(v, depth + 1);
    }
    return out;
  }
  // Functions, symbols, etc. — drop to a stable placeholder.
  return REPLACEMENT;
};
