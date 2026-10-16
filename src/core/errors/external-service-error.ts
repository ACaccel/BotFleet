/**
 * Failure originating outside the bot process — Discord API, MongoDB
 * cluster, an LLM provider, etc. Use one of the typed subclasses
 * ({@link DatabaseError}, {@link LlmProviderError}, {@link LinkPreviewError},
 * {@link FeedError}) so consumers can match on the boundary they care
 * about.
 *
 * Direct instantiation of `ExternalServiceError` is allowed but
 * discouraged: prefer one of the subclasses below so `instanceof`
 * narrowing at the call site can name the boundary.
 */
import { DomainError, type DomainErrorInit } from './domain-error';

export type ExternalServiceErrorCode =
  | 'EXTERNAL_SERVICE_FAILURE'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'INVALID_RESPONSE';

export class ExternalServiceError<
  Code extends string = ExternalServiceErrorCode,
  P extends Readonly<Record<string, string | number>> | undefined = undefined,
> extends DomainError<Code, P> {
  public constructor(init: DomainErrorInit<Code, P>) {
    super(init);
  }
}

/**
 * MongoDB / Mongoose interaction failed. Sub-code drives retry policy
 * downstream: `DUPLICATE_KEY` is rarely retryable, `TIMEOUT` /
 * `NETWORK` are retryable with backoff, `QUERY_TIMEOUT` (a query exceeded
 * its `maxTimeMS`) is not retried because the same query would run as
 * long again, `UNKNOWN` is logged and surfaced to the user as a generic
 * failure.
 *
 * The mongoose-shape → sub-code translation lives in
 * `src/persistence/error-translator.ts`; this class stays free of
 * mongoose imports so the core error layer has no driver dependency.
 */
export type DatabaseErrorCode =
  | 'DATABASE_DUPLICATE_KEY'
  | 'DATABASE_TIMEOUT'
  | 'DATABASE_QUERY_TIMEOUT'
  | 'DATABASE_NETWORK'
  | 'DATABASE_VALIDATION'
  | 'DATABASE_UNKNOWN';

export class DatabaseError<
  P extends Readonly<Record<string, string | number>> | undefined = undefined,
> extends ExternalServiceError<DatabaseErrorCode, P> {
  public constructor(init: DomainErrorInit<DatabaseErrorCode, P>) {
    super(init);
  }
}

/** LLM provider (OpenAI / Anthropic / Gemini) failure. */
export type LlmProviderErrorCode =
  | 'LLM_RATE_LIMITED'
  | 'LLM_INVALID_API_KEY'
  | 'LLM_CONTEXT_TOO_LONG'
  | 'LLM_UPSTREAM_5XX'
  | 'LLM_TIMEOUT'
  | 'LLM_UNKNOWN';

export class LlmProviderError<
  P extends Readonly<Record<string, string | number>> | undefined = undefined,
> extends ExternalServiceError<LlmProviderErrorCode, P> {
  public constructor(init: DomainErrorInit<LlmProviderErrorCode, P>) {
    super(init);
  }
}

/**
 * Link-preview generation failed — an OpenGraph scrape (e.g. Bahamut)
 * could not be fetched or returned an unusable payload. Surfaced only
 * in logs: the social-link-preview plugin stays silent in the channel
 * on failure, so the user-facing `messageKey` exists purely for catalog
 * uniformity (`DomainError.messageKey` is required).
 *
 * Sub-code drives diagnostics, mirroring {@link LlmProviderError}:
 * `TIMEOUT` / `UPSTREAM_5XX` / `RATE_LIMITED` are transient,
 * `INVALID_RESPONSE` means the page lacked the expected OpenGraph tags,
 * `FETCH_FAILED` / `UNKNOWN` cover transport and catch-all failures.
 */
export type LinkPreviewErrorCode =
  | 'LINK_PREVIEW_FETCH_FAILED'
  | 'LINK_PREVIEW_TIMEOUT'
  | 'LINK_PREVIEW_UPSTREAM_5XX'
  | 'LINK_PREVIEW_RATE_LIMITED'
  | 'LINK_PREVIEW_INVALID_RESPONSE'
  | 'LINK_PREVIEW_UNKNOWN';

export class LinkPreviewError<
  P extends Readonly<Record<string, string | number>> | undefined = undefined,
> extends ExternalServiceError<LinkPreviewErrorCode, P> {
  public constructor(init: DomainErrorInit<LinkPreviewErrorCode, P>) {
    super(init);
  }
}

/**
 * A social-feed operation failed — most often a timeline read against a
 * platform's upstream API. Like {@link LinkPreviewError} the upstream
 * failures are log-only: the social-feed poller skips the affected
 * account and retries on its next pass rather than reporting to a
 * channel.
 *
 * Sub-code drives diagnostics and the caller's response:
 * `FEED_TIMEOUT` / `FEED_UPSTREAM_5XX` / `FEED_RATE_LIMITED` are
 * transient and worth another pass; `FEED_NOT_FOUND` means the account
 * no longer exists (renamed, suspended, or a typo) and stays broken
 * until the subscription is corrected, so it is logged distinctly;
 * `FEED_INVALID_RESPONSE` means the body did not match the expected
 * schema; `FEED_FETCH_FAILED` covers transport.
 *
 * `FEED_INVALID_ACCOUNT` and `FEED_PLATFORM_NOT_CONFIGURED` are not
 * upstream failures at all — the first rejects a user-supplied account
 * string that no platform could accept, the second names a platform
 * absent from the registry. They ride on this class deliberately: one
 * feature keeps one taxonomy and one `errors:feed.*` catalog section,
 * which is worth more than the semantic purity of a separate class for
 * two codes that surface through exactly the same call sites.
 */
export type FeedErrorCode =
  | 'FEED_FETCH_FAILED'
  | 'FEED_TIMEOUT'
  | 'FEED_UPSTREAM_5XX'
  | 'FEED_RATE_LIMITED'
  | 'FEED_NOT_FOUND'
  | 'FEED_INVALID_RESPONSE'
  | 'FEED_INVALID_ACCOUNT'
  | 'FEED_PLATFORM_NOT_CONFIGURED';

export class FeedError<
  P extends Readonly<Record<string, string | number>> | undefined = undefined,
> extends ExternalServiceError<FeedErrorCode, P> {
  public constructor(init: DomainErrorInit<FeedErrorCode, P>) {
    super(init);
  }
}
