/**
 * Unit tests for the link-preview error translator: the status/transport
 * classifier and the two public constructors.
 */
import { describe, expect, it } from 'vitest';

import { LinkPreviewError } from '../../../../src/core/errors';
import {
  translateLinkPreviewError,
  invalidResponseError,
} from '../../../../src/infra/link-preview';
import { __test } from '../../../../src/infra/link-preview/error-translator';

describe('error-translator codeFor', () => {
  it('classifies transport timeouts', () => {
    expect(__test.codeFor({ status: undefined, transportCode: 'ECONNABORTED' })).toBe(
      'LINK_PREVIEW_TIMEOUT',
    );
    expect(__test.codeFor({ status: undefined, transportCode: 'ETIMEDOUT' })).toBe(
      'LINK_PREVIEW_TIMEOUT',
    );
    // c-ares's spelling, from the bounded DNS lookup.
    expect(__test.codeFor({ status: undefined, transportCode: 'ETIMEOUT' })).toBe(
      'LINK_PREVIEW_TIMEOUT',
    );
  });

  it('classifies HTTP statuses', () => {
    expect(__test.codeFor({ status: 429, transportCode: undefined })).toBe(
      'LINK_PREVIEW_RATE_LIMITED',
    );
    expect(__test.codeFor({ status: 502, transportCode: undefined })).toBe(
      'LINK_PREVIEW_UPSTREAM_5XX',
    );
    expect(__test.codeFor({ status: 404, transportCode: undefined })).toBe(
      'LINK_PREVIEW_FETCH_FAILED',
    );
  });

  it('falls back to FETCH_FAILED for an unrecognised shape', () => {
    expect(__test.codeFor({ status: undefined, transportCode: undefined })).toBe(
      'LINK_PREVIEW_FETCH_FAILED',
    );
  });
});

describe('translateLinkPreviewError', () => {
  it('builds a LinkPreviewError with provider + status params and preserves cause', () => {
    const cause = Object.assign(new Error('boom'), { response: { status: 500 } });
    const e = translateLinkPreviewError('bahamut', cause);
    expect(e).toBeInstanceOf(LinkPreviewError);
    expect(e.code).toBe('LINK_PREVIEW_UPSTREAM_5XX');
    expect(e.messageKey).toBe('errors:link_preview.upstream_failure');
    expect(e.messageParams).toEqual({ provider: 'bahamut', status: '500' });
    expect(e.cause).toBe(cause);
  });

  it('uses the transport code as the status label when no HTTP status exists', () => {
    const e = translateLinkPreviewError('bahamut', { code: 'ENOTFOUND' });
    expect(e.messageParams?.status).toBe('ENOTFOUND');
  });

  it('falls back to a "network" status label when nothing identifies the failure', () => {
    const e = translateLinkPreviewError('bahamut', new Error('opaque'));
    expect(e.messageParams?.status).toBe('network');
  });
});

describe('invalidResponseError', () => {
  it('produces an INVALID_RESPONSE error tagged with the provider', () => {
    const e = invalidResponseError('bahamut');
    expect(e.code).toBe('LINK_PREVIEW_INVALID_RESPONSE');
    expect(e.messageKey).toBe('errors:link_preview.invalid_response');
    expect(e.messageParams).toEqual({ provider: 'bahamut', status: 'invalid_response' });
  });
});
