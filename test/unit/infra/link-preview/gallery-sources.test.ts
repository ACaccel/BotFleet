/**
 * Unit tests for the nhentai and wnacg gallery sources and their
 * link-preview adapter: link recognition, metadata parsing from recorded
 * response shapes, the removed-gallery path, and SSRF filtering of page
 * image URLs that come from upstream content. A fake `GalleryHttp` keeps
 * the suite offline.
 */
import { describe, expect, it, vi } from 'vitest';

import { err, ok, type Result } from '../../../../src/core/result';
import {
  createGalleryPreviewProvider,
  createNhentaiSource,
  createWnacgSource,
  invalidResponseError,
  type GalleryHttp,
  type LinkPreviewFailure,
} from '../../../../src/infra/link-preview';
import { isSafeGalleryUrl } from '../../../../src/infra/link-preview/gallery/http';

const u = (href: string): URL => new URL(href);

const fakeHttp = (routes: Record<string, unknown>): GalleryHttp & { calls: string[] } => {
  const calls: string[] = [];
  const answer = async (url: string): Promise<Result<never, LinkPreviewFailure>> => {
    calls.push(url);
    if (!(url in routes)) return err(invalidResponseError('test'));
    return ok(routes[url] as never);
  };
  return {
    calls,
    getJson: vi.fn(answer),
    getText: vi.fn(answer),
    getImage: vi.fn(async () => ({ ok: false as const, reason: 'failed' as const })),
  };
};

const NH_API = 'https://nhentai.net/api/v2';
const nhGallery = {
  id: 123456,
  media_id: '999',
  title: { english: '[Circle] Title [English]', japanese: 'Original Title', pretty: 'Title' },
  upload_date: 1_700_000_000,
  num_favorites: 42,
  tags: [
    { id: 1, type: 'category', name: 'doujinshi' },
    { id: 2, type: 'tag', name: 'tag-a' },
    { id: 3, type: 'artist', name: 'artist-a' },
    { id: 4, type: 'tag', name: 'tag-b' },
  ],
  pages: [
    { number: 1, path: 'galleries/999/1.webp' },
    { number: 2, path: 'galleries/999/2.webp' },
  ],
};
const nhCdn = { image_servers: ['https://i1.nhentai.net', 'https://i2.nhentai.net/'] };

describe('nhentai source', () => {
  it('recognises gallery and reader links only', () => {
    const source = createNhentaiSource(fakeHttp({}));
    expect(source.parse(u('https://nhentai.net/g/123456/'))).toEqual({ id: '123456' });
    expect(source.parse(u('https://www.nhentai.net/g/123456'))).toEqual({ id: '123456' });
    expect(source.parse(u('https://nhentai.net/g/123456/7/'))).toEqual({ id: '123456', page: 7 });
    expect(source.parse(u('https://nhentai.net/g/123456/0/'))).toEqual({ id: '123456' });
    expect(source.parse(u('https://nhentai.net/tag/big/'))).toBeUndefined();
    expect(source.parse(u('https://nhentai.example/g/1/'))).toBeUndefined();
  });

  it('maps the gallery and spreads pages across the image servers', async () => {
    const source = createNhentaiSource(
      fakeHttp({ [`${NH_API}/galleries/123456`]: nhGallery, [`${NH_API}/cdn`]: nhCdn }),
    );
    const result = await source.fetch('123456', 1000);
    expect(result).toEqual(
      ok({
        source: 'nhentai',
        id: '123456',
        url: 'https://nhentai.net/g/123456/',
        title: '[Circle] Title [English]',
        subtitle: 'Original Title',
        tags: [
          { type: 'artist', names: ['artist-a'] },
          { type: 'tag', names: ['tag-a', 'tag-b'] },
        ],
        pages: [
          {
            urls: [
              'https://i1.nhentai.net/galleries/999/1.webp',
              'https://i2.nhentai.net/galleries/999/1.webp',
            ],
          },
          {
            urls: [
              'https://i2.nhentai.net/galleries/999/2.webp',
              'https://i1.nhentai.net/galleries/999/2.webp',
            ],
          },
        ],
        favorites: 42,
        uploadedAt: 1_700_000_000_000,
      }),
    );
  });

  it('reads the image-server list once per hour', async () => {
    let now = 0;
    const http = fakeHttp({ [`${NH_API}/galleries/123456`]: nhGallery, [`${NH_API}/cdn`]: nhCdn });
    const source = createNhentaiSource(http, () => now);
    await source.fetch('123456', 1000);
    await source.fetch('123456', 1000);
    expect(http.calls.filter((url) => url.endsWith('/cdn'))).toHaveLength(1);
    now = 60 * 60 * 1000 + 1;
    await source.fetch('123456', 1000);
    expect(http.calls.filter((url) => url.endsWith('/cdn'))).toHaveLength(2);
  });

  it('answers null for a removed gallery and Err for an unexpected body', async () => {
    const removed = createNhentaiSource(
      fakeHttp({ [`${NH_API}/galleries/1`]: null, [`${NH_API}/cdn`]: nhCdn }),
    );
    expect(await removed.fetch('1', 1000)).toEqual(ok(null));

    const malformed = createNhentaiSource(
      fakeHttp({ [`${NH_API}/galleries/1`]: { id: 'x' }, [`${NH_API}/cdn`]: nhCdn }),
    );
    expect((await malformed.fetch('1', 1000)).ok).toBe(false);
  });

  it('refuses image servers that are not public HTTPS hosts', async () => {
    const source = createNhentaiSource(
      fakeHttp({
        [`${NH_API}/galleries/123456`]: nhGallery,
        [`${NH_API}/cdn`]: { image_servers: ['http://i1.nhentai.net', 'https://127.0.0.1'] },
      }),
    );
    expect((await source.fetch('123456', 1000)).ok).toBe(false);
  });
});

const WN = 'https://www.wnacg.com';
const wnIndex = `<html><body><h2>[Group] Title &amp; More</h2>
<div class="addtags"><a class="tagshow" href="/t1">tag-one</a><a class="tagshow" href="/t2">tag-two</a><a class="tagshow" href="/t1">tag-one</a></div>
</body></html>`;
const wnScript = [
  'document.writeln("var fast_img_host=\\"\\";");',
  'document.writeln("var imglist = [{ url: fast_img_host+\\"//img2.example.net/data/1/01.jpg?verify=a\\", caption: \\"[01]\\"},' +
    '{ url: fast_img_host+\\"//127.0.0.1/data/1/02.jpg\\", caption: \\"[02]\\"},' +
    '{ url: fast_img_host+\\"//img2.example.net/data/1/03.jpg?verify=c\\", caption: \\"[03]\\"},' +
    '{ url: fast_img_host+\\"/themes/weitu/images/bg/shoucang.jpg\\", caption: \\"banner\\"}];");',
].join('\n');

describe('wnacg source', () => {
  it('recognises album links on the main and mirror hosts', () => {
    const source = createWnacgSource(fakeHttp({}));
    expect(source.parse(u('https://www.wnacg.com/photos-index-aid-100000.html'))).toEqual({
      id: '100000',
    });
    expect(source.parse(u('https://wnacg.com/photos-slist-aid-5.html'))).toEqual({ id: '5' });
    expect(source.parse(u('https://m.wnacg.org/photos-index-page-2-aid-7.html'))).toEqual({
      id: '7',
    });
    expect(source.parse(u('https://www.wnacg.com/photos-view-id-123.html'))).toBeUndefined();
    expect(source.parse(u('https://wnacg.example/photos-index-aid-1.html'))).toBeUndefined();
  });

  it('reads the title, tags and protocol-relative page images from the canonical host', async () => {
    const http = fakeHttp({
      [`${WN}/photos-index-aid-9.html`]: wnIndex,
      [`${WN}/photos-gallery-aid-9.html`]: wnScript,
    });
    const result = await createWnacgSource(http).fetch('9', 1000);
    expect(result).toEqual(
      ok({
        source: 'wnacg',
        id: '9',
        url: `${WN}/photos-index-aid-9.html`,
        title: '[Group] Title & More',
        tags: [{ type: 'tag', names: ['tag-one', 'tag-two'] }],
        pages: [
          { urls: ['https://img2.example.net/data/1/01.jpg?verify=a'] },
          { urls: ['https://img2.example.net/data/1/03.jpg?verify=c'] },
        ],
      }),
    );
  });

  it('answers null for a missing album, which the site serves with status 200', async () => {
    const http = fakeHttp({
      [`${WN}/photos-index-aid-9.html`]: '<html><body>gone</body></html>',
      [`${WN}/photos-gallery-aid-9.html`]: 'document.writeln("");',
    });
    expect(await createWnacgSource(http).fetch('9', 1000)).toEqual(ok(null));
  });
});

describe('createGalleryPreviewProvider', () => {
  const routes = { [`${NH_API}/galleries/123456`]: nhGallery, [`${NH_API}/cdn`]: nhCdn };

  it('returns a gallery result starting at the linked page, clamped to the gallery', async () => {
    const provider = createGalleryPreviewProvider(createNhentaiSource(fakeHttp(routes)));
    expect(provider.canHandle(u('https://nhentai.net/g/123456/'))).toBe(true);
    const result = await provider.build(u('https://nhentai.net/g/123456/9/'), { timeoutMs: 1000 });
    expect(result.ok && result.value?.kind === 'gallery' && result.value.startPage).toBe(2);
  });

  it('skips a removed gallery silently', async () => {
    const provider = createGalleryPreviewProvider(
      createNhentaiSource(fakeHttp({ [`${NH_API}/galleries/5`]: null, [`${NH_API}/cdn`]: nhCdn })),
    );
    expect(await provider.build(u('https://nhentai.net/g/5/'), { timeoutMs: 1000 })).toEqual(
      ok(null),
    );
  });
});

describe('isSafeGalleryUrl', () => {
  it.each([
    ['https://i1.nhentai.net/a.webp', true],
    ['https://img.example.net:443/a.jpg', true],
    ['http://i1.nhentai.net/a.webp', false],
    ['https://user:pw@img.example.net/a.jpg', false],
    ['https://img.example.net:8443/a.jpg', false],
    ['https://127.0.0.1/a.jpg', false],
    ['https://localhost/a.jpg', false],
    ['not a url', false],
  ])('%s -> %s', (url, expected) => {
    expect(isSafeGalleryUrl(url)).toBe(expected);
  });
});
