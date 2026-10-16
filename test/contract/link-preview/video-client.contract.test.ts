import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';

import { downloadPreviewVideo } from '../../../src/infra/link-preview';
import { createVideoLookup } from '../../../src/infra/link-preview/video-client';

const HOST = 'https://media.example.com';
const PATH = '/clip';
const VIDEO = Buffer.from('synthetic video bytes');

describe('bounded preview video download', () => {
  beforeAll(() => {
    if (!nock.isActive()) nock.activate();
    nock.disableNetConnect();
  });
  afterEach(() => {
    expect(nock.pendingMocks()).toEqual([]);
    nock.cleanAll();
  });
  afterAll(() => {
    nock.enableNetConnect();
    nock.restore();
  });

  it.each([
    ['video/mp4', 'facebook.mp4'],
    ['video/quicktime; charset=binary', 'facebook.mov'],
  ])('downloads %s with a compatible extension', async (type, name) => {
    nock(HOST).get(PATH).reply(200, VIDEO, { 'Content-Type': type });
    expect(await downloadPreviewVideo(HOST + PATH, 100, 1000)).toEqual({ data: VIDEO, name });
  });

  it.each(['text/html', 'application/octet-stream', 'video/webm'])('rejects %s', async (type) => {
    nock(HOST).get(PATH).reply(200, VIDEO, { 'Content-Type': type });
    expect(await downloadPreviewVideo(HOST + PATH, 100, 1000)).toBeNull();
  });

  it('rejects an oversized content length before buffering', async () => {
    nock(HOST)
      .get(PATH)
      .reply(200, VIDEO, { 'Content-Type': 'video/mp4', 'Content-Length': '200' });
    expect(await downloadPreviewVideo(HOST + PATH, 100, 1000)).toBeNull();
  });

  it('enforces the byte limit without a content length', async () => {
    nock(HOST).get(PATH).reply(200, VIDEO, { 'Content-Type': 'video/mp4' });
    expect(await downloadPreviewVideo(HOST + PATH, 5, 1000)).toBeNull();
  });

  it('bounds a slow response with a total deadline', async () => {
    nock(HOST).get(PATH).delay(100).reply(200, VIDEO, { 'Content-Type': 'video/mp4' });
    expect(await downloadPreviewVideo(HOST + PATH, 100, 20)).toBeNull();
  });

  it('follows a public HTTPS redirect', async () => {
    nock(HOST).get(PATH).reply(302, '', { Location: 'https://cdn.example.com/video.mp4' });
    nock('https://cdn.example.com')
      .get('/video.mp4')
      .reply(200, VIDEO, { 'Content-Type': 'video/mp4' });
    expect(await downloadPreviewVideo(HOST + PATH, 100, 1000)).toEqual({
      data: VIDEO,
      name: 'facebook.mp4',
    });
  });

  it.each([
    'https://127.0.0.1/private',
    'http://cdn.example.com/clip',
    'https://user:pass@cdn.example.com/clip',
  ])('rejects unsafe redirect %s', async (target) => {
    nock(HOST).get(PATH).reply(302, '', { Location: target });
    expect(await downloadPreviewVideo(HOST + PATH, 100, 1000)).toBeNull();
  });

  it.each([
    'https://127.0.0.1/x',
    'https://[::1]/x',
    'http://media.example.com/x',
    'https://user:pass@media.example.com/x',
    'https://media.example.com:444/x',
    'invalid',
  ])('rejects unsafe initial URL %s without a request', async (url) => {
    expect(await downloadPreviewVideo(url, 100, 1000)).toBeNull();
  });

  it('falls back immediately when both global download slots are occupied', async () => {
    nock(HOST).get('/one').delay(60).reply(200, VIDEO, { 'Content-Type': 'video/mp4' });
    nock(HOST).get('/two').delay(60).reply(200, VIDEO, { 'Content-Type': 'video/mp4' });
    const one = downloadPreviewVideo(HOST + '/one', 100, 1000);
    const two = downloadPreviewVideo(HOST + '/two', 100, 1000);
    expect(await downloadPreviewVideo(HOST + '/three', 100, 1000)).toBeNull();
    expect(await Promise.all([one, two])).toEqual([
      { data: VIDEO, name: 'facebook.mp4' },
      { data: VIDEO, name: 'facebook.mp4' },
    ]);
    nock(HOST).get('/four').reply(200, VIDEO, { 'Content-Type': 'video/mp4' });
    expect(await downloadPreviewVideo(HOST + '/four', 100, 1000)).not.toBeNull();
  });

  it('blocks private DNS answers at the socket lookup boundary', async () => {
    const lookup = createVideoLookup({
      resolve4: async () => ['127.0.0.1'],
      resolve6: async () => ['::1'],
    });
    const error = await new Promise<Error | null>((resolve) => {
      lookup('cdn.example.com', { family: 0, all: true }, (failure) => resolve(failure));
    });
    expect(error?.message).toBe('Unsafe video address');
  });
});
