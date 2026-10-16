/**
 * Translate outbound HTTP failures from an OpenGraph fetch into the
 * shared {@link LinkPreviewError} taxonomy.
 *
 * Duck-typed on the axios error shape (`code` for transport failures,
 * `response.status` for HTTP responses) rather than relying on
 * `axios.isAxiosError`, which an auto-mocked `axios` neuters in unit
 * tests — the same approach as `infra/llm/selfhosted-client.ts`. The
 * original error survives as `cause` for observability.
 */
import { LinkPreviewError, type LinkPreviewErrorCode } from '../../core/errors';

import type { LinkPreviewFailure } from './types';

/** Operation tag carried on every error a fetch path emits. */
const OPERATION = 'OgClient.fetch';

interface NormalisedHttpError {
  /** HTTP status code, when the request reached the server. */
  readonly status: number | undefined;
  /** Transport-level code (e.g. `ECONNABORTED`, `ENOTFOUND`, c-ares `ETIMEOUT`). */
  readonly transportCode: string | undefined;
}

const normalise = (e: unknown): NormalisedHttpError => {
  const errObj = (e ?? {}) as { code?: unknown; response?: { status?: unknown } };
  return {
    status: typeof errObj.response?.status === 'number' ? errObj.response.status : undefined,
    transportCode: typeof errObj.code === 'string' ? errObj.code : undefined,
  };
};

const codeFor = (n: NormalisedHttpError): LinkPreviewErrorCode => {
  // ETIMEOUT is c-ares's spelling, raised by the bounded DNS lookup when a
  // host's name servers stay silent.
  if (
    n.transportCode === 'ECONNABORTED' ||
    n.transportCode === 'ETIMEDOUT' ||
    n.transportCode === 'ETIMEOUT'
  ) {
    return 'LINK_PREVIEW_TIMEOUT';
  }
  if (n.status === 429) return 'LINK_PREVIEW_RATE_LIMITED';
  if (typeof n.status === 'number' && n.status >= 500) return 'LINK_PREVIEW_UPSTREAM_5XX';
  return 'LINK_PREVIEW_FETCH_FAILED';
};

const messageKeyFor = (code: LinkPreviewErrorCode): string => {
  switch (code) {
    case 'LINK_PREVIEW_TIMEOUT':
      return 'errors:link_preview.timeout';
    case 'LINK_PREVIEW_RATE_LIMITED':
      return 'errors:link_preview.rate_limited';
    case 'LINK_PREVIEW_UPSTREAM_5XX':
      return 'errors:link_preview.upstream_failure';
    case 'LINK_PREVIEW_INVALID_RESPONSE':
      return 'errors:link_preview.invalid_response';
    case 'LINK_PREVIEW_FETCH_FAILED':
      return 'errors:link_preview.fetch_failed';
    case 'LINK_PREVIEW_UNKNOWN':
      return 'errors:link_preview.unknown';
    default: {
      // Exhaustiveness guard: a new LinkPreviewErrorCode without a case
      // above becomes a compile error here rather than silently mapping to
      // the generic key.
      const exhaustive: never = code;
      return exhaustive;
    }
  }
};

const statusLabel = (n: NormalisedHttpError): string => {
  if (typeof n.status === 'number') return String(n.status);
  return n.transportCode ?? 'network';
};

/** Translate a thrown HTTP/transport error into a {@link LinkPreviewError}. */
export const translateLinkPreviewError = (provider: string, e: unknown): LinkPreviewFailure => {
  const n = normalise(e);
  const code = codeFor(n);
  return new LinkPreviewError({
    code,
    messageKey: messageKeyFor(code),
    messageParams: { provider, status: statusLabel(n) },
    context: { operation: OPERATION, input: { provider, status: n.status ?? null } },
    cause: e,
  });
};

/**
 * Construct the "fetched OK but the page lacked the expected OpenGraph
 * tags" error. No HTTP error was thrown, so the translator above does
 * not apply.
 */
export const invalidResponseError = (provider: string): LinkPreviewFailure =>
  new LinkPreviewError({
    code: 'LINK_PREVIEW_INVALID_RESPONSE',
    messageKey: messageKeyFor('LINK_PREVIEW_INVALID_RESPONSE'),
    messageParams: { provider, status: 'invalid_response' },
    context: { operation: OPERATION, input: { provider } },
  });

/** Test-only re-export so unit tests can introspect the classifier. */
export const __test = { normalise, codeFor, statusLabel };
