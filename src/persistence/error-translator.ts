/**
 * Translate raw mongoose / MongoDB driver errors into typed
 * {@link DatabaseError} instances.
 *
 * Lives in `persistence/` so that `core/` stays free of mongoose
 * imports and the repositories can reach the translator without an
 * upward import into `infra/mongo`. The translation here is pure
 * string-shape inspection and carries no mongoose import itself; the
 * boundary is upheld at the type level by the layer contract.
 *
 * Sub-code mapping:
 *   - `DATABASE_DUPLICATE_KEY` — MongoServerError code 11000.
 *   - `DATABASE_QUERY_TIMEOUT`  — MongoServerError code 50 (`MaxTimeMSExpired`):
 *     the query ran past its own `maxTimeMS`, so the work is too large.
 *   - `DATABASE_TIMEOUT`        — MongooseError name `MongooseServerSelectionError`,
 *     MongoNetworkTimeoutError, or any err whose message contains
 *     `'timeout'` (case-insensitive).
 *   - `DATABASE_NETWORK`        — MongoNetworkError (non-timeout).
 *   - `DATABASE_VALIDATION`     — mongoose `ValidationError` / `CastError`.
 *   - `DATABASE_UNKNOWN`        — anything else; do not swallow, surface
 *     so logs carry the original `cause`.
 *
 * The translation is intentionally string-shape-based (duck-typed) so
 * mongoose version bumps don't require a coordinated upgrade — we
 * inspect `name` + `code` + `message` rather than `instanceof`.
 */
import { DatabaseError, type DatabaseErrorCode } from '../core/errors/external-service-error';
import type { ErrorContext } from '../core/errors/error-context';

interface MongoLikeError {
  readonly name?: string;
  readonly message?: string;
  readonly code?: number | string;
  readonly codeName?: string;
}

const classify = (raw: unknown): DatabaseErrorCode => {
  if (typeof raw !== 'object' || raw === null) return 'DATABASE_UNKNOWN';
  const e = raw as MongoLikeError;
  const code = e.code;
  const name = e.name ?? '';
  const message = e.message ?? '';
  // 11000 is the well-known duplicate-key code; mongoose preserves it
  // on the wrapped error.
  if (code === 11000 || code === '11000') return 'DATABASE_DUPLICATE_KEY';
  if (name === 'ValidationError' || name === 'CastError') return 'DATABASE_VALIDATION';
  // Checked before the generic timeout patterns: a query that exceeded its own
  // time limit is too large, not a connectivity problem worth retrying.
  if (code === 50 || code === '50' || e.codeName === 'MaxTimeMSExpired')
    return 'DATABASE_QUERY_TIMEOUT';
  // ServerSelection covers "could not pick a primary in time" — the
  // most common timeout shape from the driver.
  if (
    name === 'MongooseServerSelectionError' ||
    name === 'MongoServerSelectionError' ||
    name === 'MongoNetworkTimeoutError' ||
    // Two patterns intentionally: `/timeout/i` matches the continuous
    // word ("timeout"); `/\btimed?\s*out\b/i` also covers the spaced
    // variant ("timed out"). Mongo error messages use both.
    /timeout/i.test(message) ||
    /\btimed?\s*out\b/i.test(message)
  ) {
    return 'DATABASE_TIMEOUT';
  }
  if (name === 'MongoNetworkError' || /ECONNREFUSED|ENOTFOUND|ECONNRESET/.test(message)) {
    return 'DATABASE_NETWORK';
  }
  return 'DATABASE_UNKNOWN';
};

/**
 * Map a {@link DatabaseErrorCode} to its i18n catalog key.
 *
 * The key uses the i18next `namespace:key.path` convention (colon
 * separator) so the value can be handed straight to `DomainError.messageKey`
 * and resolved by the handler boundary. Every key returned here
 * has a toned entry under the `db` object of `errors.json` in both
 * locales; none of these texts carry an interpolation placeholder because
 * {@link databaseErrorFrom} does not populate `messageParams`.
 */
const i18nKeyFor = (code: DatabaseErrorCode): string => {
  switch (code) {
    case 'DATABASE_DUPLICATE_KEY':
      return 'errors:db.duplicate_key';
    case 'DATABASE_TIMEOUT':
      return 'errors:db.timeout';
    case 'DATABASE_QUERY_TIMEOUT':
      return 'errors:db.query_timeout';
    case 'DATABASE_NETWORK':
      return 'errors:db.network';
    case 'DATABASE_VALIDATION':
      return 'errors:db.validation';
    case 'DATABASE_UNKNOWN':
      return 'errors:db.unavailable';
  }
};

/**
 * Wrap a raw mongoose / driver error as a typed {@link DatabaseError}.
 *
 * `context.operation` is required (per ErrorContext contract); pass
 * the full `"<Class>.<method>"` shape the rest of the codebase uses.
 */
export const databaseErrorFrom = (raw: unknown, context: ErrorContext): DatabaseError => {
  const code = classify(raw);
  return new DatabaseError({
    code,
    messageKey: i18nKeyFor(code),
    context,
    cause: raw,
  });
};

/**
 * Decide whether a {@link DatabaseError} represents a *transient*
 * failure — one worth retrying — versus a *persistent* one.
 *
 * Only `DATABASE_TIMEOUT` and `DATABASE_NETWORK` are transient: a
 * server-selection timeout or a dropped/refused socket can clear on
 * its own (replica-set election, brief network blip), so a bounded
 * retry has a real chance of succeeding. Every other sub-code
 * (`DATABASE_DUPLICATE_KEY`, `DATABASE_VALIDATION`, `DATABASE_UNKNOWN`)
 * is treated as persistent: retrying a duplicate-key or a malformed
 * document just burns the backoff budget and ends in the same error.
 *
 * Consumed by `infra/mongo/connection-manager.ts` to drive the
 * transient-retry / persistent-disable split. Kept here, next to
 * {@link databaseErrorFrom}, so the sub-code classification and the
 * retry-eligibility policy stay in one module and cannot drift.
 */
export const isTransient = (error: DatabaseError): boolean =>
  error.code === 'DATABASE_TIMEOUT' || error.code === 'DATABASE_NETWORK';

/** Test-only export so unit tests can pin the classifier without going through `databaseErrorFrom`. */
export const __classifyMongoErrorForTests = classify;
