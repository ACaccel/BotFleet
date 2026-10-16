/**
 * Unit tests for the shared retry primitive.
 *
 * `isRetryableError` is the branch-dense half — every accepted shape and
 * a representative rejection gets a case, because a wrongly-classified
 * error either burns the whole backoff budget on a permanent failure or
 * gives up on a recoverable one. `retryFetch` is driven with fake timers
 * so the backoff waits cost no wall-clock time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isRetryableError, retryFetch } from '../../../../src/core/retry';

describe('isRetryableError', () => {
  it.each([null, undefined])('rejects the empty value %s', (value) => {
    expect(isRetryableError(value)).toBe(false);
  });

  it.each([500, 502, 503, 599, 429])('accepts a transient status %i', (status) => {
    expect(isRetryableError({ status })).toBe(true);
  });

  it('accepts a discord.js-style `httpStatus`', () => {
    expect(isRetryableError({ httpStatus: 503 })).toBe(true);
  });

  it('accepts an axios-style nested `response.status`', () => {
    expect(isRetryableError({ response: { status: 500 } })).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])('rejects a client-error status %i', (status) => {
    expect(isRetryableError({ status })).toBe(false);
  });

  it('prefers the flat status over the nested one when both are present', () => {
    // A flat 404 with a nested 500 must not be retried: the flat field is
    // the one discord.js sets, and it is the authoritative outcome.
    expect(isRetryableError({ status: 404, response: { status: 500 } })).toBe(false);
  });

  it.each(['ConnectTimeoutError', 'AbortError', 'FetchError'])(
    'accepts the transient error name %s',
    (name) => {
      expect(isRetryableError({ name })).toBe(true);
    },
  );

  it('rejects an unrelated error name', () => {
    expect(isRetryableError({ name: 'TypeError' })).toBe(false);
  });

  it.each([
    'ECONNRESET',
    'ECONNREFUSED',
    'ECONNABORTED',
    'ETIMEDOUT',
    'EPIPE',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENETDOWN',
    'ENOTFOUND',
    'EAI_AGAIN',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
  ])('accepts the socket-level code %s', (code) => {
    expect(isRetryableError({ code })).toBe(true);
  });

  it('accepts the bare Node socket error a lost route produces', () => {
    // Exact shape Node throws when the host loses its route to Discord
    // mid-read: a plain Error with the errno name as `code` and no status.
    const err = Object.assign(new Error('read EHOSTUNREACH'), {
      code: 'EHOSTUNREACH',
      errno: -113,
      syscall: 'read',
    });
    expect(isRetryableError(err)).toBe(true);
  });

  it('rejects a non-string code', () => {
    expect(isRetryableError({ code: 113 })).toBe(false);
  });

  it('rejects an unrelated transport code', () => {
    expect(isRetryableError({ code: 'ERR_BAD_REQUEST' })).toBe(false);
  });

  it.each(['ConnectTimeoutError: fetch failed', 'Service Unavailable'])(
    'falls back to the stringified message for %s',
    (message) => {
      expect(isRetryableError(new Error(message))).toBe(true);
    },
  );

  it('rejects an error whose message matches nothing', () => {
    expect(isRetryableError(new Error('Unknown Channel'))).toBe(false);
  });

  it('rejects a primitive that carries no retry signal', () => {
    expect(isRetryableError('nope')).toBe(false);
  });
});

describe('retryFetch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin the jitter so the asserted delays are exact rather than a range.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns the value without waiting when the first attempt succeeds', async () => {
    const fn = vi.fn(async () => 'ok');
    await expect(retryFetch(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable failure and resolves with the later success', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 503 }))
      .mockResolvedValue('recovered');

    const promise = retryFetch(fn);
    await vi.advanceTimersByTimeAsync(2000);

    await expect(promise).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('rethrows a non-retryable failure immediately, without a backoff wait', async () => {
    const cause = Object.assign(new Error('Unknown Channel'), { status: 404 });
    const fn = vi.fn(async () => {
      throw cause;
    });

    await expect(retryFetch(fn)).rejects.toBe(cause);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after `maxAttempts` and rethrows the last error', async () => {
    const cause = Object.assign(new Error('still down'), { status: 500 });
    const fn = vi.fn(async () => {
      throw cause;
    });

    const promise = retryFetch(fn, { maxAttempts: 3, initialDelayMs: 10 });
    const assertion = expect(promise).rejects.toBe(cause);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('doubles the backoff between attempts', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error('1'), { status: 500 }))
      .mockRejectedValueOnce(Object.assign(new Error('2'), { status: 500 }))
      .mockResolvedValue('done');

    const promise = retryFetch(fn, { initialDelayMs: 100 });

    // Jitter is pinned to `0.5 + 0.5 = 1`, so the waits are exactly the
    // nominal 100ms then 200ms.
    await vi.advanceTimersByTimeAsync(99);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    await expect(promise).resolves.toBe('done');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('makes exactly one attempt when retrying is disabled', async () => {
    const cause = Object.assign(new Error('down'), { status: 500 });
    const fn = vi.fn(async () => {
      throw cause;
    });

    await expect(retryFetch(fn, { maxAttempts: 1 })).rejects.toBe(cause);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('honours a caller-supplied predicate that narrows the default', async () => {
    // The social-feed client uses this to stop retrying a 429: what counts as
    // transient depends on who owns the rate-limit budget.
    const cause = Object.assign(new Error('Too Many Requests'), { response: { status: 429 } });
    const fn = vi.fn(async () => {
      throw cause;
    });

    await expect(
      retryFetch(fn, {
        shouldRetry: (e) => isRetryableError(e) && !String(e).includes('Too Many'),
      }),
    ).rejects.toBe(cause);
    // The default predicate would have retried this five times.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('can widen as well as narrow, and still respects maxAttempts', async () => {
    const cause = new Error('normally not retryable');
    const fn = vi.fn(async () => {
      throw cause;
    });

    const promise = retryFetch(fn, {
      shouldRetry: () => true,
      maxAttempts: 2,
      initialDelayMs: 10,
    });
    const assertion = expect(promise).rejects.toBe(cause);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;

    expect(fn).toHaveBeenCalledTimes(2);
  });
});
