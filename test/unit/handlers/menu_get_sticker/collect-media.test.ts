import { Collection, StickerFormatType, type Sticker } from 'discord.js';
import { describe, expect, it } from 'vitest';

import { collectMedia } from '../../../../src/handlers/commands/menu_get_sticker/collect-media';

const sticker = (id: string, format: StickerFormatType) =>
  ({ id, name: `s${id}`, url: `https://media.example/${id}`, format }) as Sticker;

describe('collectMedia', () => {
  it('lists stickers, then every distinct custom emoji in the text', () => {
    const stickers = new Collection([['1', sticker('1', StickerFormatType.PNG)]]);

    const items = collectMedia(stickers, 'hi <:cat:11> and <a:dance:22> and <:cat:11> again');

    expect(items.map((item) => [item.kind, item.name, item.url])).toEqual([
      ['sticker', 's1', 'https://media.example/1'],
      ['emoji', 'cat', 'https://cdn.discordapp.com/emojis/11.png'],
      ['emoji', 'dance', 'https://cdn.discordapp.com/emojis/22.gif'],
    ]);
  });

  it('marks a Lottie sticker as not previewable', () => {
    const stickers = new Collection([['2', sticker('2', StickerFormatType.Lottie)]]);

    expect(collectMedia(stickers, '')[0]?.previewable).toBe(false);
  });

  it('finds nothing in plain text', () => {
    expect(collectMedia(new Collection(), 'just words :smile:')).toEqual([]);
  });
});
