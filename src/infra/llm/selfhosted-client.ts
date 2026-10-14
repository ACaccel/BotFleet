/**
 * SelfHostedLlmClient: outbound adapter for a lightweight self-hosted LLM
 * HTTP endpoint.
 *
 * Deliberately does NOT implement the {@link LLMProvider} Strategy in
 * `./types.ts`: the endpoint's contract differs from the SDK-backed
 * providers in every dimension that interface assumes:
 *   - the request is a single baked `user` message carrying the whole
 *     transcript, not a multi-turn `messages` array with a system prompt;
 *   - the response is `{ status, response }`, not an SDK completion;
 *   - there is no API key, model id, or temperature to thread through.
 * Failures map into the shared {@link ExternalServiceError} taxonomy so
 * callers handle them uniformly.
 */
import axios from 'axios';
import { z } from 'zod';

import { ExternalServiceError, type ExternalServiceErrorCode } from '../../core/errors';
import { ok, err, type Result } from '../../core/result';

/** Operation tag carried on every error this client emits. */
const OPERATION = 'SelfHostedLlmClient.reply';
/** Sentinel value the endpoint returns on success; any other `status` is a failure. */
const SUCCESS_STATUS = 'success';

/**
 * Expected response body. `.passthrough()` tolerates extra fields the
 * endpoint may add without failing validation.
 */
const ResponseSchema = z
  .object({
    status: z.string(),
    response: z.string(),
  })
  .passthrough();

/**
 * Error shape this client surfaces. The `{ provider, status }` params
 * mirror the SDK providers' shape so the shared `errors:llm.*` catalog
 * templates render even though an auto-reply failure is only logged.
 */
type SelfHostedLlmError = ExternalServiceError<
  ExternalServiceErrorCode,
  { provider: string; status: string }
>;

interface SelfHostedLlmClientOptions {
  /** Fully-qualified chat endpoint URL (e.g. `https://host/chat`), fixed at startup. */
  readonly endpoint: string;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs: number;
}

export class SelfHostedLlmClient {
  public constructor(private readonly options: SelfHostedLlmClientOptions) {}

  /**
   * POST `transcript` as a single user message and return the model's
   * reply text. Never throws a `DomainError`: every failure mode
   * (timeout, HTTP error, malformed body, non-success status) is mapped
   * into the Result's error channel so the caller can stay silent on
   * failure.
   */
  public async reply(transcript: string): Promise<Result<string, SelfHostedLlmError>> {
    try {
      const res = await axios.post(
        this.options.endpoint,
        { messages: [{ role: 'user', content: transcript }] },
        {
          timeout: this.options.timeoutMs,
          headers: { 'Content-Type': 'application/json' },
        },
      );
      const parsed = ResponseSchema.safeParse(res.data);
      if (!parsed.success) {
        return err(
          this.buildError(
            'INVALID_RESPONSE',
            'errors:llm.unknown',
            'invalid_response',
            parsed.error,
          ),
        );
      }
      if (parsed.data.status !== SUCCESS_STATUS) {
        return err(
          this.buildError(
            'EXTERNAL_SERVICE_FAILURE',
            'errors:llm.upstream_failure',
            parsed.data.status,
          ),
        );
      }
      return ok(parsed.data.response);
    } catch (e: unknown) {
      return err(this.translateRequestError(e));
    }
  }

  /**
   * Map a thrown request error into the typed taxonomy by duck-typing on
   * the axios error shape (`code` for transport failures, `response.status`
   * for HTTP responses). Mirrors `error-translator.ts`'s approach rather
   * than relying on `axios.isAxiosError`, which an auto-mocked `axios`
   * neuters in unit tests.
   */
  private translateRequestError(e: unknown): SelfHostedLlmError {
    const errObj = (e ?? {}) as { code?: unknown; response?: { status?: unknown } };
    const transportCode = typeof errObj.code === 'string' ? errObj.code : undefined;
    const httpStatus =
      typeof errObj.response?.status === 'number' ? errObj.response.status : undefined;

    if (transportCode === 'ECONNABORTED' || transportCode === 'ETIMEDOUT') {
      return this.buildError('TIMEOUT', 'errors:llm.timeout', 'timeout', e);
    }
    if (httpStatus === 429) {
      return this.buildError('RATE_LIMITED', 'errors:llm.rate_limited', '429', e);
    }
    return this.buildError(
      'EXTERNAL_SERVICE_FAILURE',
      'errors:llm.upstream_failure',
      httpStatus === undefined ? 'network' : String(httpStatus),
      e,
    );
  }

  private buildError(
    code: ExternalServiceErrorCode,
    messageKey: string,
    status: string,
    cause?: unknown,
  ): SelfHostedLlmError {
    return new ExternalServiceError({
      code,
      messageKey,
      messageParams: { provider: 'selfhosted', status },
      context: { operation: OPERATION, input: { endpoint: this.options.endpoint, status } },
      cause,
    });
  }
}
