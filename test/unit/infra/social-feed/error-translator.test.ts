/**
 * Unit tests for the social-feed error classifier.
 *
 * Driven through the `__test` seam so each branch and each catalog
 * mapping is pinned directly. Reaching the classifier only through
 * `FxTwitterTimelineSource` leaves most of it uncovered: those tests
 * assert `.code` for a handful of statuses and never look at the
 * `messageKey`, so a swapped mapping would render the wrong operator
 * message with the whole suite green.
 */
import { describe, expect, it } from 'vitest';

import {
  __test,
  invalidResponseError,
  translateFeedError,
} from '../../../../src/infra/social-feed/platforms/error-translator';
import { FeedError, type FeedErrorCode } from '../../../../src/core/errors';

const { normalise, codeFor, statusLabel } = __test;

const PLATFORM = 'X';
const ACCOUNT = 'someaccount';

const httpError = (status: number): unknown =>
  Object.assign(new Error(`HTTP ${String(status)}`), { response: { status } });

const transportError = (code: string): unknown => Object.assign(new Error(code), { code });

describe('normalise', () => {
  it('extracts a nested HTTP status', () => {
    expect(normalise(httpError(503))).toEqual({ status: 503, transportCode: undefined });
  });

  it('extracts a transport code', () => {
    expect(normalise(transportError('ECONNRESET'))).toEqual({
      status: undefined,
      transportCode: 'ECONNRESET',
    });
  });

  it.each([null, undefined, 'a string', 42])('tolerates the non-object value %s', (value) => {
    expect(normalise(value)).toEqual({ status: undefined, transportCode: undefined });
  });

  it('ignores a non-numeric status and a non-string code', () => {
    expect(normalise({ response: { status: '500' }, code: 7 })).toEqual({
      status: undefined,
      transportCode: undefined,
    });
  });
});

describe('codeFor', () => {
  it.each(['ECONNABORTED', 'ETIMEDOUT', 'ERR_CANCELED'])(
    'classifies the transport code %s as a timeout',
    (transportCode) => {
      expect(codeFor({ status: undefined, transportCode })).toBe('FEED_TIMEOUT');
    },
  );

  it.each([
    [404, 'FEED_NOT_FOUND'],
    [429, 'FEED_RATE_LIMITED'],
    [500, 'FEED_UPSTREAM_5XX'],
    [503, 'FEED_UPSTREAM_5XX'],
    [400, 'FEED_FETCH_FAILED'],
    [403, 'FEED_FETCH_FAILED'],
  ])('classifies HTTP %i as %s', (status, expected) => {
    expect(codeFor({ status, transportCode: undefined })).toBe(expected);
  });

  it('prefers the timeout classification over the status', () => {
    // An aborted request can still carry a partial response; the timeout
    // is the more actionable diagnosis.
    expect(codeFor({ status: 500, transportCode: 'ECONNABORTED' })).toBe('FEED_TIMEOUT');
  });

  it('falls back to fetch-failed with neither a status nor a code', () => {
    expect(codeFor({ status: undefined, transportCode: undefined })).toBe('FEED_FETCH_FAILED');
  });
});

describe('statusLabel', () => {
  it('prefers the numeric status', () => {
    expect(statusLabel({ status: 404, transportCode: 'ECONNRESET' })).toBe('404');
  });

  it('falls back to the transport code', () => {
    expect(statusLabel({ status: undefined, transportCode: 'ENOTFOUND' })).toBe('ENOTFOUND');
  });

  it('labels a bare failure as `network`', () => {
    expect(statusLabel({ status: undefined, transportCode: undefined })).toBe('network');
  });
});

describe('translateFeedError', () => {
  it.each<[number, FeedErrorCode, string]>([
    [404, 'FEED_NOT_FOUND', 'errors:feed.not_found'],
    [429, 'FEED_RATE_LIMITED', 'errors:feed.rate_limited'],
    [502, 'FEED_UPSTREAM_5XX', 'errors:feed.upstream_failure'],
    [400, 'FEED_FETCH_FAILED', 'errors:feed.fetch_failed'],
  ])('maps HTTP %i to %s with its own catalog key', (status, code, messageKey) => {
    const error = translateFeedError(PLATFORM, ACCOUNT, httpError(status));
    expect(error.code).toBe(code);
    expect(error.messageKey).toBe(messageKey);
  });

  it('maps a timeout to its own catalog key', () => {
    const error = translateFeedError(PLATFORM, ACCOUNT, transportError('ETIMEDOUT'));
    expect(error.code).toBe('FEED_TIMEOUT');
    expect(error.messageKey).toBe('errors:feed.timeout');
  });

  it('carries the platform, the account, the status label, the operation, and the cause', () => {
    const cause = httpError(503);
    const error = translateFeedError(PLATFORM, ACCOUNT, cause);

    expect(error.messageParams).toEqual({
      platform: PLATFORM,
      account: ACCOUNT,
      status: '503',
    });
    expect(error.context.operation).toBe('FxTwitterTimelineSource.fetchTimeline');
    expect(error.context.input).toEqual({ platform: PLATFORM, account: ACCOUNT, status: '503' });
    expect(error.cause).toBe(cause);
    expect(error).toBeInstanceOf(FeedError);
  });
});

describe('invalidResponseError', () => {
  it('uses the invalid-response code and key', () => {
    const error = invalidResponseError(PLATFORM, ACCOUNT);
    expect(error.code).toBe('FEED_INVALID_RESPONSE');
    expect(error.messageKey).toBe('errors:feed.invalid_response');
    expect(error.messageParams).toEqual({
      platform: PLATFORM,
      account: ACCOUNT,
      status: 'invalid_response',
    });
  });

  it('preserves an optional cause, such as a zod error', () => {
    const cause = new Error('zod said no');
    expect(invalidResponseError(PLATFORM, ACCOUNT, cause).cause).toBe(cause);
  });
});
