/**
 * Unit tests for {@link SelfHostedLlmClient}. axios is auto-mocked so the
 * tests drive the request/response and failure-mapping logic without a
 * network. Each case reassigns `axios.post` (the `attachment-archive`
 * pattern) to control the resolved/rejected value.
 */
import { describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { SelfHostedLlmClient } from '../../../../src/infra/llm';
import { isErr, isOk } from '../../../../src/core/result';

vi.mock('axios');

const ENDPOINT = 'https://host.invalid/chat';
const TIMEOUT_MS = 5000;

const makeClient = (): SelfHostedLlmClient =>
  new SelfHostedLlmClient({ endpoint: ENDPOINT, timeoutMs: TIMEOUT_MS });

const setPost = (impl: (...args: unknown[]) => Promise<unknown>): ReturnType<typeof vi.fn> => {
  const post = vi.fn(impl);
  (axios.post as unknown as ReturnType<typeof vi.fn>) = post;
  return post;
};

describe('SelfHostedLlmClient.reply', () => {
  it('posts the transcript as a single user message and returns the response (happy path)', async () => {
    const post = setPost(async () => ({
      data: { status: 'success', response: '很好啊 你賺了100萬' },
    }));
    const result = await makeClient().reply('transcript-text');

    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toBe('很好啊 你賺了100萬');
    expect(post).toHaveBeenCalledWith(
      ENDPOINT,
      { messages: [{ role: 'user', content: 'transcript-text' }] },
      expect.objectContaining({ timeout: TIMEOUT_MS }),
    );
  });

  it('returns EXTERNAL_SERVICE_FAILURE when status is not "success"', async () => {
    setPost(async () => ({ data: { status: 'error', response: '' } }));
    const result = await makeClient().reply('t');

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('EXTERNAL_SERVICE_FAILURE');
  });

  it('returns INVALID_RESPONSE when the body shape is wrong', async () => {
    setPost(async () => ({ data: { status: 'success' } })); // missing `response`
    const result = await makeClient().reply('t');

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('INVALID_RESPONSE');
  });

  it('maps an axios timeout (ECONNABORTED) to TIMEOUT', async () => {
    setPost(async () => {
      throw Object.assign(new Error('timeout of 5000ms exceeded'), { code: 'ECONNABORTED' });
    });
    const result = await makeClient().reply('t');

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('TIMEOUT');
  });

  it('maps an HTTP 500 to EXTERNAL_SERVICE_FAILURE and preserves operation + cause', async () => {
    const cause = Object.assign(new Error('Server Error'), { response: { status: 500 } });
    setPost(async () => {
      throw cause;
    });
    const result = await makeClient().reply('t');

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('EXTERNAL_SERVICE_FAILURE');
      expect(result.error.context.operation).toBe('SelfHostedLlmClient.reply');
      expect(result.error.cause).toBe(cause);
    }
  });

  it('maps an HTTP 429 to RATE_LIMITED', async () => {
    setPost(async () => {
      throw Object.assign(new Error('Too Many Requests'), { response: { status: 429 } });
    });
    const result = await makeClient().reply('t');

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('RATE_LIMITED');
  });
});
