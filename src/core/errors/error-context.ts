/**
 * Shape of the structured context carried on every {@link DomainError}.
 *
 * `operation` is **required** so every error answers "what was being
 * done when this failed" without callers needing to grep stacks.
 * Additional fields are open-ended (IDs, sanitised input, retry count)
 * but must never carry secrets — the logger redacts known field names
 * (see `src/core/config/redact.ts`) but cannot detect ad-hoc keys
 * containing tokens.
 *
 * Convention for `operation`: `"<Class>.<method>"` for class-scoped
 * failures, `"<module>.<function>"` for free functions
 * (e.g. `"MongoArchiveStatsRepo.activity"`,
 * `"MongoConnectionManager.open"`).
 */
export interface ErrorContext {
  /** What was being attempted, e.g. `"MongoArchiveStatsRepo.activity"`. */
  readonly operation: string;
  /** Sanitised input that scoped the failure (IDs, counts, flags). */
  readonly input?: Readonly<Record<string, unknown>>;
  /** Open-ended additional fields. Same redaction rules as `input`. */
  readonly [key: string]: unknown;
}
