/**
 * Unit tests for the gallery reader message and its customId contract:
 * button targets and disabled states at either end, unique ids when two
 * buttons target one page, first-page details, and round-tripping every id
 * the view writes.
 */
import { describe, expect, it } from 'vitest';

import {
  decodeGalleryButtonId,
  decodeGalleryModalId,
  encodeGalleryJumpModalId,
} from '../../../../src/application/gallery-reader/custom-id';
import {
  buildGalleryJumpModal,
  buildGalleryMessage,
} from '../../../../src/application/gallery-reader/view';
import type { Gallery } from '../../../../src/infra/link-preview';

const t = (key: string, params?: Record<string, unknown>): string =>
  params === undefined ? key : `${key} ${JSON.stringify(params)}`;

const gallery: Gallery = {
  source: 'wnacg',
  id: '100000',
  url: 'https://www.wnacg.com/photos-index-aid-100000.html',
  title: 'Title',
  subtitle: 'Original',
  tags: [{ type: 'tag', names: ['a', 'b'] }],
  pages: Array.from({ length: 3 }, (_, i) => ({ urls: [`https://img.example.net/${i}.jpg`] })),
  favorites: 7,
};
const image = { kind: 'file' as const, image: { data: Buffer.from([1]), extension: 'jpg' } };

const buttons = (page: number) =>
  buildGalleryMessage(gallery, page, image, t).components[0]?.toJSON().components as Array<{
    custom_id: string;
    disabled?: boolean;
    label?: string;
  }>;

describe('buildGalleryMessage', () => {
  it('shows details on the first page and disables backward buttons there', () => {
    const message = buildGalleryMessage(gallery, 1, image, t);
    const embed = message.embeds[0]?.toJSON();
    expect(embed?.image?.url).toBe('attachment://wnacg-100000-1.jpg');
    expect(embed?.url).toBe(gallery.url);
    expect(embed?.description).toBe('Original');
    expect(embed?.fields?.map((field) => field.name)).toEqual([
      'replies:gallery_preview.tag_types.tag',
      'replies:gallery_preview.pages',
      'replies:gallery_preview.favorites',
    ]);
    expect(message.files[0]?.name).toBe('wnacg-100000-1.jpg');
    expect(message.allowedMentions).toEqual({ parse: [] });
    expect(buttons(1).map((b) => b.disabled ?? false)).toEqual([true, true, false, false, false]);
  });

  it('points the embed at a staged URL and uploads nothing', () => {
    const url = 'https://cdn.discordapp.com/attachments/1/2/wnacg-100000-2.jpg';
    const message = buildGalleryMessage(gallery, 2, { kind: 'url', url }, t);
    expect(message.embeds[0]?.toJSON().image?.url).toBe(url);
    expect(message.files).toEqual([]);
  });

  it('keeps later pages compact and disables forward buttons on the last page', () => {
    const embed = buildGalleryMessage(gallery, 3, image, t).embeds[0]?.toJSON();
    expect(embed?.fields ?? []).toEqual([]);
    expect(embed?.footer?.text).toContain('"page":3');
    const row = buttons(3);
    expect(row.map((b) => b.disabled ?? false)).toEqual([false, false, false, true, true]);
    expect(row[2]?.label).toBe('3 / 3');
  });

  it('writes unique, decodable button ids targeting the right pages', () => {
    const row = buttons(2);
    const ids = row.map((b) => b.custom_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.map(decodeGalleryButtonId)).toEqual([
      { source: 'wnacg', id: '100000', action: 'page', page: 1 },
      { source: 'wnacg', id: '100000', action: 'page', page: 1 },
      { source: 'wnacg', id: '100000', action: 'jump', total: 3 },
      { source: 'wnacg', id: '100000', action: 'page', page: 3 },
      { source: 'wnacg', id: '100000', action: 'page', page: 3 },
    ]);
  });

  it('builds a jump form whose id decodes back to the gallery', () => {
    // Discord caps form labels at 45 characters, so the catalog key alone stands in.
    const modal = buildGalleryJumpModal(gallery, 3, (key) => key).toJSON();
    expect(decodeGalleryModalId(modal.custom_id)).toEqual({ source: 'wnacg', id: '100000' });
    expect(modal.custom_id).toBe(encodeGalleryJumpModalId(gallery));
  });
});

describe('gallery customId decoding', () => {
  it.each([
    'gallery_page|pixiv|1|2|n',
    'gallery_page|nhentai|abc|2|n',
    'gallery_page|nhentai|1|2|x',
    'gallery_page|nhentai|1|jump',
    'level_page|u|1',
  ])('rejects %s', (id) => {
    expect(decodeGalleryButtonId(id)).toBeUndefined();
  });

  it('rejects a modal id for an unknown source', () => {
    expect(decodeGalleryModalId('gallery_page|pixiv|1')).toBeUndefined();
  });
});
