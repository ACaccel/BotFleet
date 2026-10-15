/**
 * Unit tests for the gallery HTTP client's outcome mapping: a removed
 * resource reads as `null` (not a fault), stale image URLs read as `gone`
 * so the reader refetches metadata, and unsupported or oversize image
 * bodies are refused. axios is mocked; the SSRF screen runs for real.
 */
import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import { createGalleryHttp } from '../../../../src/infra/link-preview/gallery/http';

vi.mock('axios');

const setGet = (impl: (...args: unknown[]) => Promise<unknown>): ReturnType<typeof vi.fn> => {
  const get = vi.fn(impl);
  (axios.get as unknown as ReturnType<typeof vi.fn>) = get;
  return get;
};

const httpError = (status: number): Error =>
  Object.assign(new Error('http'), { response: { status } });

describe('createGalleryHttp', () => {
  it('reads text and treats a 404 as a missing resource', async () => {
    const http = createGalleryHttp();
    setGet(async () => ({ data: '<h2>t</h2>', headers: { 'content-type': 'text/html' } }));
    expect(await http.getText('https://www.wnacg.com/a.html', 'wnacg', 1000)).toEqual({
      ok: true,
      value: '<h2>t</h2>',
    });
    setGet(async () => {
      throw httpError(404);
    });
    expect(await http.getJson('https://nhentai.net/api/v2/galleries/1', 'nhentai', 1000)).toEqual({
      ok: true,
      value: null,
    });
    setGet(async () => {
      throw httpError(503);
    });
    expect((await http.getText('https://www.wnacg.com/a.html', 'wnacg', 1000)).ok).toBe(false);
  });

  it('downloads a supported image and names its extension', async () => {
    const http = createGalleryHttp();
    setGet(async () => ({
      data: new Uint8Array([1, 2, 3]).buffer,
      headers: { 'content-type': 'image/webp; charset=binary' },
    }));
    const outcome = await http.getImage('https://i1.nhentai.net/a.webp', 10, 1000);
    expect(outcome).toEqual({
      ok: true,
      image: { data: Buffer.from([1, 2, 3]), extension: 'webp' },
    });
  });

  it('classifies stale URLs as gone and other failures as failed', async () => {
    const http = createGalleryHttp();
    setGet(async () => {
      throw httpError(403);
    });
    expect(await http.getImage('https://img.example.net/a.jpg', 10, 1000)).toEqual({
      ok: false,
      reason: 'gone',
    });
    setGet(async () => {
      throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
    });
    expect(await http.getImage('https://img.example.net/a.jpg', 10, 1000)).toEqual({
      ok: false,
      reason: 'failed',
    });
    setGet(async () => ({ data: new ArrayBuffer(4), headers: { 'content-type': 'text/html' } }));
    expect(await http.getImage('https://img.example.net/a.jpg', 10, 1000)).toEqual({
      ok: false,
      reason: 'failed',
    });
  });

  it('never requests a private address', async () => {
    const http = createGalleryHttp();
    const get = setGet(async () => ({ data: new ArrayBuffer(1), headers: {} }));
    expect(await http.getImage('https://10.0.0.1/a.jpg', 10, 1000)).toEqual({
      ok: false,
      reason: 'failed',
    });
    expect(get).not.toHaveBeenCalled();
  });
});
