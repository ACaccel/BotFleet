/**
 * Translate upstream SDK / HTTP errors into the shared
 * {@link LlmProviderError} taxonomy.
 *
 * The translator is duck-typed on `status` (HTTP code) and the
 * provider-specific error payload — every supported SDK (OpenAI,
 * Anthropic, Gemini, xAI through OpenAI-compat) exposes a `.status`
 * field on its error subclass, and the HTTP body carries the provider's
 * machine-readable code (e.g. OpenAI's `context_length_exceeded`,
 * Anthropic's `rate_limit_error`).
 *
 * A free function rather than per-provider methods because the
 * classification rules share a structural core (401 → INVALID_API_KEY,
 * 429 → RATE_LIMITED, 5xx → UPSTREAM_5XX); provider-specific overrides
 * (context-length detection) plug in via the `extraContextLengthCheck`
 * predicate.
 */
import { LlmProviderError, type LlmProviderErrorCode } from '../../core/errors';
import type { LLMProviderName } from './types';

/**
 * Provider-specific error shape extracted by best-effort duck typing.
 * Every supported SDK exposes (some subset of) these fields on its
 * thrown error subclass.
 */
interface NormalisedUpstreamError {
  status: number | undefined;
  /** Provider-specific machine-readable code (e.g. `context_length_exceeded`). */
  code: string | undefined;
  /** Provider-specific error type (e.g. Anthropic's `rate_limit_error`). */
  type: string | undefined;
  /** Free-form error message text the SDK threw. */
  message: string;
}

const normalise = (err: unknown): NormalisedUpstreamError => {
  if (err === null || err === undefined) {
    return { status: undefined, code: undefined, type: undefined, message: 'unknown' };
  }
  if (typeof err === 'string') {
    return { status: undefined, code: undefined, type: undefined, message: err };
  }
  const anyErr = err as {
    status?: number;
    statusCode?: number;
    code?: string | number;
    type?: string;
    name?: string;
    message?: string;
    error?: { code?: string; type?: string; message?: string };
    response?: {
      status?: number;
      data?: { error?: { code?: string; type?: string; message?: string } };
    };
  };
  // OpenAI / Anthropic SDK -> err.error.{code,type}; Gemini SDK ->
  // err.message contains "[400 ...]" or "[429 ...]"; OpenAI-compat
  // raw HTTP -> err.response.data.error.{code,type}.
  const nestedCode =
    typeof anyErr.code === 'string'
      ? anyErr.code
      : (anyErr.error?.code ?? anyErr.response?.data?.error?.code);
  const nestedType = anyErr.type ?? anyErr.error?.type ?? anyErr.response?.data?.error?.type;
  // Provider SDKs scatter the human-readable text across several
  // paths (top-level `.message`, `.error.message`, or
  // `.response.data.error.message`). Fall back through them so the
  // context-length regex check below sees the actual prose.
  const message =
    anyErr.message ?? anyErr.error?.message ?? anyErr.response?.data?.error?.message ?? String(err);
  return {
    status: anyErr.status ?? anyErr.statusCode ?? anyErr.response?.status,
    code: typeof nestedCode === 'string' ? nestedCode : undefined,
    type: typeof nestedType === 'string' ? nestedType : undefined,
    message,
  };
};

const CONTEXT_LENGTH_CODES = new Set([
  // OpenAI
  'context_length_exceeded',
  // Anthropic
  'invalid_request_error', // ambiguous; we additionally check the message text below
]);

const CONTEXT_LENGTH_MESSAGE_PATTERNS = [
  /context length/i,
  /context window/i,
  /maximum.*tokens/i,
  /too many.*tokens/i,
  /token limit/i,
];

const isContextLengthError = (n: NormalisedUpstreamError): boolean => {
  if (n.code !== undefined && CONTEXT_LENGTH_CODES.has(n.code)) {
    if (n.code === 'invalid_request_error') {
      return CONTEXT_LENGTH_MESSAGE_PATTERNS.some((re) => re.test(n.message));
    }
    return true;
  }
  return CONTEXT_LENGTH_MESSAGE_PATTERNS.some((re) => re.test(n.message));
};

const codeFor = (n: NormalisedUpstreamError): LlmProviderErrorCode => {
  if (n.status === 429 || n.type === 'rate_limit_error' || n.code === 'rate_limit_exceeded') {
    return 'LLM_RATE_LIMITED';
  }
  if (n.status === 401 || n.status === 403 || n.type === 'authentication_error') {
    return 'LLM_INVALID_API_KEY';
  }
  if (n.status === 400 && isContextLengthError(n)) {
    return 'LLM_CONTEXT_TOO_LONG';
  }
  if (typeof n.status === 'number' && n.status >= 500) {
    return 'LLM_UPSTREAM_5XX';
  }
  // Network-layer / timeout errors land here too; the operation-level
  // code is still meaningful (LLM_UNKNOWN) and the cause preserves
  // the original stack.
  return 'LLM_UNKNOWN';
};

/**
 * Translate an SDK / HTTP error thrown by any LLM provider adapter
 * into the shared {@link LlmProviderError}. The original error
 * survives as the `cause` so observability tools can drill in.
 */
export const translateProviderError = (
  provider: LLMProviderName,
  operation: string,
  err: unknown,
): LlmProviderError<{ provider: string; status: string }> => {
  const n = normalise(err);
  const code = codeFor(n);
  return new LlmProviderError({
    code,
    messageKey: messageKeyFor(code),
    messageParams: {
      provider,
      status: n.status === undefined ? 'unknown' : String(n.status),
    },
    context: {
      operation,
      input: {
        provider,
        status: n.status ?? null,
        upstreamCode: n.code ?? null,
        upstreamType: n.type ?? null,
      },
    },
    cause: err,
  });
};

const messageKeyFor = (code: LlmProviderErrorCode): string => {
  switch (code) {
    case 'LLM_RATE_LIMITED':
      return 'errors:llm.rate_limited';
    case 'LLM_INVALID_API_KEY':
      return 'errors:llm.invalid_api_key';
    case 'LLM_CONTEXT_TOO_LONG':
      return 'errors:llm.context_too_long';
    case 'LLM_UPSTREAM_5XX':
      return 'errors:llm.upstream_failure';
    case 'LLM_TIMEOUT':
      return 'errors:llm.timeout';
    case 'LLM_UNKNOWN':
      return 'errors:llm.unknown';
  }
};

/**
 * Construct a typed {@link LlmProviderError} for the "provider returned
 * an HTTP-200 but empty content" boundary failure. The SDK did not
 * throw — it returned a structurally invalid payload — so the generic
 * translator above does not apply. Surfaces as `LLM_UNKNOWN` so the
 * user message is the safe generic fallback; ops sees the typed kind
 * plus the operation string in the log.
 */
export const emptyResponseError = (
  provider: LLMProviderName,
  operation: string,
): LlmProviderError<{ provider: string; status: string }> =>
  new LlmProviderError({
    code: 'LLM_UNKNOWN',
    messageKey: 'errors:llm.unknown',
    messageParams: { provider, status: 'empty_response' },
    context: { operation, input: { provider } },
  });
