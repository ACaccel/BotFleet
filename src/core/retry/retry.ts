/**
 * Bounded exponential-backoff retry for transient outbound failures.
 *
 * Shared by the message-backup channel walker (Discord REST) and the
 * social-feed poller (a third-party HTTP API), which need the same policy:
 * absorb a transient blip, surface a real failure immediately.
 *
 * Relationship to `isTransientNetworkError` (`core/errors`): that
 * predicate answers a narrower question — "is this thrown value one of
 * the socket-level resets the process-level `uncaughtException` net may
 * tolerate?" It inspects `Error` instances only and knows nothing about
 * HTTP status codes or undici's `UND_ERR_*` family.
 * {@link isRetryableError} is deliberately broader, because a bounded
 * retry is cheap whereas swallowing an uncaught exception is not. The
 * two stay separate so widening the retry policy can never widen what
 * the crash handler tolerates. The OS socket codes below overlap with
 * that predicate's whitelist because both describe real transient
 * failures; each list is maintained on its own.
 */

/** Attempts made before a retryable failure is rethrown. */
const DEFAULT_MAX_ATTEMPTS = 5;
/** First backoff wait; doubled after every retryable failure. */
const DEFAULT_INITIAL_DELAY_MS = 2000;

/**
 * Transport-level error codes worth another attempt. Node surfaces OS
 * socket failures as a bare `Error` whose `code` is the errno name;
 * undici uses its own `UND_ERR_*` family. Every entry describes a
 * failure that clears on its own once the network path recovers — a
 * route flap, a resolver hiccup, a peer that dropped mid-flight.
 */
const RETRYABLE_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET', // peer reset an established connection
  'ECONNREFUSED', // peer refused the connection (restart / failover)
  'ECONNABORTED', // connection aborted locally mid-flight
  'ETIMEDOUT', // connection or socket timed out
  'EPIPE', // wrote to a socket the peer had already closed
  'EHOSTUNREACH', // no route to host
  'ENETUNREACH', // network unreachable
  'ENETDOWN', // local network interface is down
  'ENOTFOUND', // DNS lookup failed (transient resolver/outage)
  'EAI_AGAIN', // DNS lookup temporarily failed / timed out
  'UND_ERR_SOCKET', // undici: socket error on an in-flight request
  'UND_ERR_CONNECT_TIMEOUT', // undici: connect phase timed out
]);

/** Tunables for {@link retryFetch}. Every field has a production default. */
interface RetryOptions {
  /** Total attempts, including the first. Values below 1 disable retrying. */
  readonly maxAttempts?: number;
  /** Backoff wait before the second attempt, in milliseconds. */
  readonly initialDelayMs?: number;
  /**
   * Which thrown values are worth another attempt. Defaults to
   * {@link isRetryableError}.
   *
   * Exists so a caller can *narrow* the default rather than widen it:
   * what counts as transient depends on who owns the rate-limit budget.
   * A client talking to a library that queues its own rate limits can
   * retry a 429; one talking straight to a shared upstream should not.
   */
  readonly shouldRetry?: (err: unknown) => boolean;
}

/**
 * Shape a retry decision can be read from. Thrown values reach here from
 * discord.js (`DiscordAPIError`), axios (`response.status` / `code`), and
 * undici (`UND_ERR_*`), so every field is optional and duck-typed.
 */
interface RetryableErrorShape {
  readonly status?: number;
  readonly httpStatus?: number;
  readonly name?: string;
  readonly code?: string;
  readonly response?: { readonly status?: number };
}

/**
 * Decide whether a thrown value is worth another attempt.
 *
 * Intentionally generous on the network-failure side: one outbound call
 * can fail as a `DiscordAPIError`, an undici `UND_ERR_*`, an axios
 * transport code, or a bare `Error` from the ws layer. Anything that
 * looks like a transient 5xx, a 429, or a transport-level socket / DNS
 * failure retries; 4xx,
 * Unknown Channel, and validation errors propagate immediately so a
 * permanent failure is not paid for five times.
 */
export const isRetryableError = (err: unknown): boolean => {
  if (err === null || err === undefined) return false;
  const anyErr = err as RetryableErrorShape;
  // discord.js exposes `status`/`httpStatus`; axios nests it under `response`.
  const status = anyErr.status ?? anyErr.httpStatus ?? anyErr.response?.status;
  if (typeof status === 'number' && (status >= 500 || status === 429)) return true;
  if (
    anyErr.name === 'ConnectTimeoutError' ||
    anyErr.name === 'AbortError' ||
    anyErr.name === 'FetchError'
  ) {
    return true;
  }
  if (typeof anyErr.code === 'string' && RETRYABLE_TRANSPORT_CODES.has(anyErr.code)) {
    return true;
  }
  const msg = String(err);
  return msg.includes('ConnectTimeoutError') || msg.includes('Service Unavailable');
};

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying while {@link isRetryableError} accepts the thrown
 * value and attempts remain. The jitter coefficient `(0.5 + random)`
 * keeps concurrent callers from synchronising their retry waves.
 *
 * @throws the last thrown value once attempts are exhausted, or the
 *   first non-retryable one — the error channel is never swallowed.
 */
export const retryFetch = async <T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> => {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const shouldRetry = options.shouldRetry ?? isRetryableError;
  let delay = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  // Unbounded `for` rather than a counted loop with a trailing throw: the
  // body always returns or throws, so there is no unreachable tail.
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (!shouldRetry(err) || attempt >= maxAttempts) throw err;
      await sleep(delay * (0.5 + Math.random()));
      delay *= 2;
    }
  }
};
