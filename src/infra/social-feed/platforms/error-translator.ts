/**
 * Translate outbound HTTP failures from a timeline read into the shared
 * {@link FeedError} taxonomy.
 *
 * Duck-typed on the axios error shape (`code` for transport failures,
 * `response.status` for HTTP responses) rather than `axios.isAxiosError`,
 * which an auto-mocked `axios` neuters in unit tests. The original error
 * survives as `cause` for observability.
 *
 * The platform name travels as data so the catalog templates can name it,
 * but `OPERATION` below deliberately does not: it records the class that
 * actually issued the request, which is what an operator greps on. Other
 * platforms supply their operation tag while sharing the HTTP taxonomy.
 */
import { FeedError, type FeedErrorCode } from '../../../core/errors';

import type { FeedFailure } from '../types';

/** Operation tag carried on every error a timeline read emits. */
const OPERATION = 'FxTwitterTimelineSource.fetchTimeline';

interface NormalisedHttpError {
  /** HTTP status code, when the request reached the server. */
  readonly status: number | undefined;
  /** Transport-level code (e.g. `ECONNABORTED`, `ENOTFOUND`). */
  readonly transportCode: string | undefined;
}

const normalise = (e: unknown): NormalisedHttpError => {
  const errObj = (e ?? {}) as { code?: unknown; response?: { status?: unknown } };
  return {
    status: typeof errObj.response?.status === 'number' ? errObj.response.status : undefined,
    transportCode: typeof errObj.code === 'string' ? errObj.code : undefined,
  };
};

const codeFor = (n: NormalisedHttpError): FeedErrorCode => {
  // `ECONNABORTED` is axios's own inactivity timeout and `ETIMEDOUT` the
  // socket-level one; `ERR_CANCELED` is what axios reports when the
  // absolute-deadline `AbortSignal` fires. All three mean "too slow".
  if (
    n.transportCode === 'ECONNABORTED' ||
    n.transportCode === 'ETIMEDOUT' ||
    n.transportCode === 'ERR_CANCELED'
  ) {
    return 'FEED_TIMEOUT';
  }
  // 404 is the "account does not exist" signal — renamed, suspended, or
  // a typo in the subscription. It stays broken until the subscription
  // is corrected, so it is coded apart from the transient failures above
  // and below.
  if (n.status === 404) return 'FEED_NOT_FOUND';
  if (n.status === 429) return 'FEED_RATE_LIMITED';
  if (typeof n.status === 'number' && n.status >= 500) return 'FEED_UPSTREAM_5XX';
  return 'FEED_FETCH_FAILED';
};

const messageKeyFor = (code: FeedErrorCode): string => {
  switch (code) {
    case 'FEED_TIMEOUT':
      return 'errors:feed.timeout';
    case 'FEED_RATE_LIMITED':
      return 'errors:feed.rate_limited';
    case 'FEED_UPSTREAM_5XX':
      return 'errors:feed.upstream_failure';
    case 'FEED_NOT_FOUND':
      return 'errors:feed.not_found';
    case 'FEED_INVALID_RESPONSE':
      return 'errors:feed.invalid_response';
    case 'FEED_INVALID_ACCOUNT':
      return 'errors:feed.invalid_account';
    case 'FEED_PLATFORM_NOT_CONFIGURED':
      return 'errors:feed.platform_not_configured';
    case 'FEED_FETCH_FAILED':
      return 'errors:feed.fetch_failed';
    default: {
      // Exhaustiveness guard: a new FeedErrorCode without a case above
      // becomes a compile error here rather than silently falling back.
      const exhaustive: never = code;
      return exhaustive;
    }
  }
};

const statusLabel = (n: NormalisedHttpError): string => {
  if (typeof n.status === 'number') return String(n.status);
  return n.transportCode ?? 'network';
};

const buildError = (
  platform: string,
  account: string,
  code: FeedErrorCode,
  status: string,
  cause: unknown,
  operation = OPERATION,
): FeedFailure =>
  new FeedError({
    code,
    messageKey: messageKeyFor(code),
    messageParams: { platform, account, status },
    context: { operation, input: { platform, account, status } },
    cause,
  });

/** Translate a thrown HTTP/transport error into a {@link FeedError}. */
export const translateFeedError = (
  platform: string,
  account: string,
  e: unknown,
  operation = OPERATION,
): FeedFailure => {
  const n = normalise(e);
  return buildError(platform, account, codeFor(n), statusLabel(n), e, operation);
};

/**
 * Construct the "responded 200 but the body did not match the expected
 * schema" error. No HTTP error was thrown, so the translator above does
 * not apply.
 */
export const invalidResponseError = (
  platform: string,
  account: string,
  cause?: unknown,
  operation = OPERATION,
): FeedFailure =>
  buildError(platform, account, 'FEED_INVALID_RESPONSE', 'invalid_response', cause, operation);

/** Test-only re-export so unit tests can introspect the classifier. */
export const __test = { normalise, codeFor, statusLabel };
