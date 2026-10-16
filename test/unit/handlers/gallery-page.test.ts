/**
 * Unit tests for the `gallery_page` button and jump-form handlers: the
 * inactive-reader and age-restriction refusals, opening the jump form, a
 * page turn that replaces the previous upload, a page that fails to load,
 * and jump-form validation.
 */
import { describe, expect, it, vi } from 'vitest';
import { MessageFlags, type Message } from 'discord.js';

import gallery_page from '../../../src/handlers/buttons/gallery_page';
import gallery_page_modal from '../../../src/handlers/modals/gallery_page';
import type { GalleryPageOutcome } from '../../../src/application/gallery-reader/service';
import type { Gallery } from '../../../src/infra/link-preview';
import { buildFakeBot } from '../../fixtures/discord/bot-fake';
import {
  buildButtonInteraction,
  buildModalSubmitInteraction,
  newInteractionSink,
} from '../../fixtures/discord/interaction-builder';

const gallery: Gallery = {
  source: 'nhentai',
  id: '1',
  url: 'https://nhentai.net/g/1/',
  title: 'Title',
  tags: [],
  pages: Array.from({ length: 3 }, (_, i) => ({ urls: [`https://i1.nhentai.net/${i}.webp`] })),
};
const loaded = (page: number): GalleryPageOutcome => ({
  status: 'ok',
  gallery,
  page,
  media: { kind: 'file', image: { data: Buffer.from([1]), extension: 'webp' } },
});

const fakeReader = (outcome: GalleryPageOutcome) => ({
  supports: (source: string) => source === 'nhentai',
  loadPage: vi.fn(async () => outcome),
  serialize: vi.fn(async <T>(_key: string, task: () => Promise<T>) => task()),
});

const channel = (nsfw: boolean) => ({ id: 'c-1', isThread: () => false, nsfw });
const message = { id: 'm-1' } as unknown as Message;

const press = async (
  customId: string,
  opts: { reader?: ReturnType<typeof fakeReader>; nsfw?: boolean } = {},
) => {
  const sink = newInteractionSink();
  const showModal = vi.fn();
  const interaction = Object.assign(
    buildButtonInteraction({ customId, channel: channel(opts.nsfw ?? true), message, sink }),
    { showModal },
  );
  const { bot } = buildFakeBot({ galleryReader: opts.reader });
  await new gallery_page().execute(interaction, bot);
  return { sink, showModal };
};

describe('gallery_page button handler', () => {
  it('refuses privately when the reader is gone or the source is unknown', async () => {
    const { sink } = await press('gallery_page|nhentai|1|2|n');
    expect(sink.replies).toEqual([
      { content: 'replies:gallery_preview.inactive', flags: MessageFlags.Ephemeral },
    ]);
    const unknown = await press('gallery_page|wnacg|1|2|n', { reader: fakeReader(loaded(2)) });
    expect(unknown.sink.replies[0]?.content).toBe('replies:gallery_preview.inactive');
  });

  it('refuses outside an age-restricted channel without loading anything', async () => {
    const reader = fakeReader(loaded(2));
    const { sink } = await press('gallery_page|nhentai|1|2|n', { reader, nsfw: false });
    expect(sink.replies[0]?.content).toBe('replies:gallery_preview.age_restricted');
    expect(reader.loadPage).not.toHaveBeenCalled();
  });

  it('opens the jump form from the position button', async () => {
    const reader = fakeReader(loaded(2));
    const { showModal, sink } = await press('gallery_page|nhentai|1|jump|3', { reader });
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(sink.deferUpdates).toHaveLength(0);
  });

  it('turns the page under the message lock and replaces the previous upload', async () => {
    const reader = fakeReader(loaded(2));
    const { sink } = await press('gallery_page|nhentai|1|2|n', { reader });
    expect(sink.deferUpdates).toHaveLength(1);
    expect(reader.serialize).toHaveBeenCalledWith('m-1', expect.any(Function));
    expect(reader.loadPage).toHaveBeenCalledWith('nhentai', '1', 2);
    const edit = sink.editReplies[0] as { attachments: unknown[]; files: unknown[] };
    expect(edit.attachments).toEqual([]);
    expect(edit.files).toHaveLength(1);
  });

  it('shows a staged page by URL without uploading and drops the old attachment', async () => {
    const reader = fakeReader({
      status: 'ok',
      gallery,
      page: 2,
      media: { kind: 'url', url: 'https://cdn.discordapp.com/attachments/1/2/p.webp' },
    });
    const { sink } = await press('gallery_page|nhentai|1|2|n', { reader });
    const edit = sink.editReplies[0] as {
      attachments: unknown[];
      files: unknown[];
      embeds: Array<{ toJSON(): { image?: { url: string } } }>;
    };
    expect(edit.files).toEqual([]);
    expect(edit.attachments).toEqual([]);
    expect(edit.embeds[0]?.toJSON().image?.url).toBe(
      'https://cdn.discordapp.com/attachments/1/2/p.webp',
    );
  });

  it('keeps the page and tells only the presser when it cannot be loaded', async () => {
    const { sink } = await press('gallery_page|nhentai|1|2|n', {
      reader: fakeReader({ status: 'unavailable' }),
    });
    expect(sink.editReplies).toHaveLength(0);
    expect(sink.followUps).toEqual([
      { content: 'replies:gallery_preview.unavailable', flags: MessageFlags.Ephemeral },
    ]);
  });
});

const submit = async (
  value: string,
  opts: { reader?: ReturnType<typeof fakeReader>; fromMessage?: boolean } = {},
) => {
  const sink = newInteractionSink();
  const interaction = Object.assign(
    buildModalSubmitInteraction({
      customId: 'gallery_page|nhentai|1',
      channel: channel(true) as never,
      textInputs: { page: value },
      sink,
    }),
    {
      message,
      isFromMessage: () => opts.fromMessage ?? true,
      deferUpdate: async () => {
        sink.deferUpdates.push({});
        sink.acknowledged.deferred = true;
      },
    },
  );
  const { bot } = buildFakeBot({ galleryReader: opts.reader });
  await new gallery_page_modal().execute(interaction, bot);
  return sink;
};

describe('gallery_page jump form handler', () => {
  it('jumps to the submitted page', async () => {
    const reader = fakeReader(loaded(3));
    const sink = await submit(' 3 ', { reader });
    expect(reader.loadPage).toHaveBeenCalledWith('nhentai', '1', 3);
    expect(sink.editReplies).toHaveLength(1);
  });

  it.each(['0', 'abc', '-1', '1.5'])('rejects %s as a page number', async (value) => {
    const reader = fakeReader(loaded(1));
    const sink = await submit(value, { reader });
    expect(sink.replies[0]?.content).toBe('replies:gallery_preview.jump_invalid');
    expect(reader.loadPage).not.toHaveBeenCalled();
  });

  it('refuses a form that did not come from a reader message', async () => {
    const sink = await submit('2', { reader: fakeReader(loaded(2)), fromMessage: false });
    expect(sink.replies[0]?.content).toBe('replies:gallery_preview.inactive');
  });
});
