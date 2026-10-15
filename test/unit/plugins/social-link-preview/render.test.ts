/**
 * Unit tests for {@link renderPreview} / {@link buildCardEmbed}: the
 * discriminated-union reply dispatch and embed assembly. A minimal fake
 * Message captures the reply payload; the translator is stubbed.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ComponentType,
  DiscordAPIError,
  HTTPError,
  MessageFlags,
  type AttachmentBuilder,
  type ContainerBuilder,
  type Message,
} from 'discord.js';

import {
  renderPreview,
  buildCardEmbed,
} from '../../../../src/plugins/social-link-preview/internal/render';
import type { Translator } from '../../../../src/core/i18n';
import type { RenderablePreviewResult } from '../../../../src/infra/link-preview';
import { buildMessage } from '../../../fixtures/discord/message-builder';
import { echoTranslator } from '../../../fixtures/runtime';

const makeTranslator = (): Translator => ({
  ...echoTranslator(),
  t: vi.fn((key: string, params?: { provider?: string; count?: number | string }) => {
    const statistics: Record<string, string> = {
      'replies:social_link_preview.engagement_likes': '👍',
      'replies:social_link_preview.engagement_comments': '💬',
      'replies:social_link_preview.engagement_shares': '🔄',
    };
    const icon = statistics[key];
    return icon === undefined ? `${key}|${params?.provider ?? ''}` : `${icon} ${params?.count}`;
  }),
});

interface ReplyPayload {
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
  flags?: number;
  files?: AttachmentBuilder[];
  allowedMentions?: { parse: readonly string[] };
}

const makeMessage = (): { message: Message; replies: ReplyPayload[] } => {
  const replies: ReplyPayload[] = [];
  const message = buildMessage({
    reply: vi.fn(async (payload: ReplyPayload) => {
      replies.push(payload);
      return {};
    }),
  });
  return { message, replies };
};

describe('renderPreview', () => {
  const facebookResult: RenderablePreviewResult = {
    kind: 'card',
    card: {
      url: 'https://www.facebook.com/reel/1',
      title: 'Reel title',
      description: 'Post text',
      imageUrl: 'https://cdn.example/poster.jpg',
      siteName: 'Facebook',
      authorName: 'Author',
    },
    media: { url: 'https://cdn.example/video.mp4', fallbackUrl: 'https://proxy.example/reel/1' },
    sourceUrl: 'https://www.facebook.com/reel/1',
  };

  it.each(['Facebook', 'Threads', 'Instagram', 'Example'])(
    'places the uploaded %s video after all card metadata in one message',
    async (siteName) => {
      const { message, replies } = makeMessage();
      const data = Buffer.from('video');
      const downloadVideo = vi.fn().mockResolvedValue({ data, name: 'preview.mp4' });
      if (facebookResult.kind !== 'card') throw new Error('expected a card');
      await renderPreview(
        message,
        {
          ...facebookResult,
          card: { ...facebookResult.card, siteName, engagement: { likes: 12 } },
        },
        makeTranslator(),
        { downloadVideo },
      );

      expect(downloadVideo).toHaveBeenCalledWith(
        'https://cdn.example/video.mp4',
        8 * 1024 * 1024,
        15_000,
      );
      expect(replies).toHaveLength(1);
      expect(replies[0]?.files?.[0]?.attachment).toEqual(data);
      expect(replies[0]?.files?.[0]?.name).toBe('preview.mp4');
      const payload = replies[0]!;
      expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
      expect(payload.embeds).toBeUndefined();
      const container = (payload.components?.[0] as ContainerBuilder).toJSON();
      expect(container.accent_color).toBe(siteName === 'Facebook' ? 0x1877f2 : 0x5865f2);
      const metadata = container.components.slice(0, -1);
      expect(metadata.every((component) => component.type === ComponentType.TextDisplay)).toBe(
        true,
      );
      expect(JSON.stringify(metadata)).toContain(siteName === 'Facebook' ? 'Author' : 'Reel title');
      expect(JSON.stringify(metadata)).toContain('https://www.facebook.com/reel/1');
      expect(JSON.stringify(metadata)).toContain('Post text');
      expect(JSON.stringify(metadata)).toContain(siteName === 'Facebook' ? '👍 12' : siteName);
      expect(JSON.stringify(container)).not.toContain('poster.jpg');
      expect(container.components.at(-1)).toEqual({
        type: ComponentType.MediaGallery,
        items: [{ media: { url: 'attachment://preview.mp4' } }],
      });
      expect(replies[0]?.allowedMentions).toEqual({ parse: [] });
      expect(replies[0]?.content).toBeUndefined();
    },
  );

  it.each(['uploaded', 'unavailable', 'rejected', 'disabled'] as const)(
    'renders a Threads video card when attachment delivery is %s',
    async (delivery) => {
      const { message, replies } = makeMessage();
      const data = Buffer.from('video');
      const downloadVideo = vi
        .fn()
        .mockResolvedValue(delivery === 'unavailable' ? null : { data, name: 'preview.mp4' });
      if (delivery === 'rejected') {
        vi.mocked(message.reply).mockRejectedValueOnce(
          new DiscordAPIError(
            { code: 40005, message: 'Upload rejected' },
            40005,
            400,
            'POST',
            'https://discord.test/channels/1/messages',
            {},
          ),
        );
      }
      const sourceUrl = 'https://www.threads.com/@user/post/Cabc';
      const fallbackUrl = 'https://viewthreads.com/@user/post/Cabc';
      const result: RenderablePreviewResult = {
        kind: 'card',
        card: {
          url: sourceUrl,
          title: 'Author on Threads',
          description: 'Post text',
          imageUrl: 'https://cdn.example/poster.jpg',
          siteName: 'Threads',
        },
        media: { url: 'https://cdn.example/video.mp4', fallbackUrl },
        sourceUrl,
      };

      await renderPreview(message, result, makeTranslator(), {
        downloadVideo,
        videoEnabled: delivery !== 'disabled',
        maxVideoBytes: 1234,
        videoTimeoutMs: 500,
      });

      expect(replies).toHaveLength(1);
      expect(replies[0]?.allowedMentions).toEqual({ parse: [] });
      if (delivery === 'uploaded') {
        expect(replies[0]?.flags).toBe(MessageFlags.IsComponentsV2);
        const container = (replies[0]?.components?.[0] as ContainerBuilder).toJSON();
        expect(JSON.stringify(container)).toContain(`**[Author on Threads](${sourceUrl})**`);
        expect(container.components.at(-1)?.type).toBe(ComponentType.MediaGallery);
        expect(replies[0]?.files?.[0]?.attachment).toEqual(data);
        expect(replies[0]?.embeds).toBeUndefined();
        expect(replies[0]?.content).toBeUndefined();
      } else {
        const embed = replies[0]?.embeds?.[0] as {
          data: { url: string; title: string; image?: { url: string } };
        };
        expect(embed.data.url).toBe(sourceUrl);
        expect(embed.data.title).toBe('Author on Threads');
        expect(replies[0]?.files).toBeUndefined();
        expect(embed.data.image?.url).toBe('https://cdn.example/poster.jpg');
        expect(replies[0]?.content).toBe(delivery === 'disabled' ? undefined : `<${fallbackUrl}>`);
      }
      if (delivery === 'disabled') expect(downloadVideo).not.toHaveBeenCalled();
      else expect(downloadVideo).toHaveBeenCalledWith('https://cdn.example/video.mp4', 1234, 500);
    },
  );

  it('keeps the source link above the video when card text is missing', async () => {
    const { message, replies } = makeMessage();
    if (facebookResult.kind !== 'card') throw new Error('expected a card');
    await renderPreview(
      message,
      { ...facebookResult, card: { url: facebookResult.card.url } },
      makeTranslator(),
      { downloadVideo: vi.fn().mockResolvedValue({ data: Buffer.from('video'), name: 'v.mov' }) },
    );
    const container = (replies[0]?.components?.[0] as ContainerBuilder).toJSON();
    expect(container.components).toEqual([
      { type: ComponentType.TextDisplay, content: '<https://www.facebook.com/reel/1>' },
      { type: ComponentType.MediaGallery, items: [{ media: { url: 'attachment://v.mov' } }] },
    ]);
  });

  it('escapes upstream markdown in video card titles and descriptions', async () => {
    const { message, replies } = makeMessage();
    if (facebookResult.kind !== 'card') throw new Error('expected a card');
    await renderPreview(
      message,
      {
        ...facebookResult,
        card: {
          url: facebookResult.card.url,
          title: '**Title**',
          description: '# Heading\n[masked](https://example.test)',
        },
      },
      makeTranslator(),
      { downloadVideo: vi.fn().mockResolvedValue({ data: Buffer.from('video'), name: 'v.mp4' }) },
    );
    const container = (replies[0]?.components?.[0] as ContainerBuilder).toJSON();
    expect(container.components[0]).toEqual({
      type: ComponentType.TextDisplay,
      content: '**[\\*\\*Title\\*\\*](https://www.facebook.com/reel/1)**',
    });
    expect(container.components[1]).toEqual({
      type: ComponentType.TextDisplay,
      content: '\\# Heading\n\\[masked](https://example.test)',
    });
  });

  it.each([true, false])(
    'retains an optional announcement with Facebook video delivery (%s)',
    async (uploadable) => {
      const { message, replies } = makeMessage();
      await renderPreview(message, facebookResult, makeTranslator(), {
        announcement: 'Source announcement',
        downloadVideo: vi
          .fn()
          .mockResolvedValue(
            uploadable ? { data: Buffer.from('video'), name: 'preview.mp4' } : null,
          ),
      });
      expect(replies).toHaveLength(1);
      if (uploadable) {
        expect(replies[0]?.content).toBeUndefined();
        const container = (replies[0]?.components?.[0] as ContainerBuilder).toJSON();
        expect(container.components[0]).toEqual({
          type: ComponentType.TextDisplay,
          content: 'Source announcement',
        });
        expect(container.components.at(-1)?.type).toBe(ComponentType.MediaGallery);
      } else {
        expect(replies[0]?.content).toBe('Source announcement\n<https://proxy.example/reel/1>');
      }
    },
  );

  it('uses the configured download limits and falls back when the video is unavailable or oversized', async () => {
    const { message, replies } = makeMessage();
    const downloadVideo = vi.fn().mockResolvedValue(null);
    await renderPreview(message, facebookResult, makeTranslator(), {
      downloadVideo,
      maxVideoBytes: 1234,
      videoTimeoutMs: 500,
    });

    expect(downloadVideo).toHaveBeenCalledWith('https://cdn.example/video.mp4', 1234, 500);
    expect(replies[0]?.content).toBe('<https://proxy.example/reel/1>');
    expect(replies[0]?.files).toBeUndefined();
    expect((replies[0]?.embeds?.[0] as { data: { image?: unknown } }).data.image).toBeDefined();
    expect(replies[0]?.allowedMentions).toEqual({ parse: [] });
  });

  it('falls back to the card and link if the downloader throws', async () => {
    const { message, replies } = makeMessage();
    await renderPreview(message, facebookResult, makeTranslator(), {
      downloadVideo: vi.fn().mockRejectedValue(new Error('Timeout')),
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]?.content).toBe('<https://proxy.example/reel/1>');
  });

  it.each([
    [40005, 400],
    [50045, 400],
    [50013, 403],
    [0, 413],
  ])('falls back after an upload rejection with code %s and status %s', async (code, status) => {
    const { message, replies } = makeMessage();
    const error = new DiscordAPIError(
      { code, message: 'Upload rejected' },
      code,
      status,
      'POST',
      'https://discord.test/channels/1/messages',
      {},
    );
    vi.mocked(message.reply).mockRejectedValueOnce(error);
    await renderPreview(message, facebookResult, makeTranslator(), {
      downloadVideo: vi.fn().mockResolvedValue({ data: Buffer.from('video'), name: 'preview.mp4' }),
    });
    expect(message.reply).toHaveBeenCalledTimes(2);
    expect(replies[0]?.content).toBe('<https://proxy.example/reel/1>');
    expect(replies[0]?.files).toBeUndefined();
  });

  it.each([10008, 50035])(
    'preserves non-upload Discord errors without retrying (%s)',
    async (code) => {
      const { message } = makeMessage();
      const error = new DiscordAPIError(
        { code, message: 'Reply rejected' },
        code,
        400,
        'POST',
        'https://discord.test/channels/1/messages',
        {},
      );
      vi.mocked(message.reply).mockRejectedValueOnce(error);
      await expect(
        renderPreview(message, facebookResult, makeTranslator(), {
          downloadVideo: vi
            .fn()
            .mockResolvedValue({ data: Buffer.from('video'), name: 'preview.mp4' }),
        }),
      ).rejects.toBe(error);
      expect(message.reply).toHaveBeenCalledTimes(1);
    },
  );

  it('falls back when Discord returns a plain HTTP 413 error', async () => {
    const { message, replies } = makeMessage();
    vi.mocked(message.reply).mockRejectedValueOnce(
      new HTTPError(
        413,
        'Payload Too Large',
        'POST',
        'https://discord.test/channels/1/messages',
        {},
      ),
    );
    await renderPreview(message, facebookResult, makeTranslator(), {
      downloadVideo: vi.fn().mockResolvedValue({ data: Buffer.from('video'), name: 'preview.mp4' }),
    });
    expect(message.reply).toHaveBeenCalledTimes(2);
    expect(replies[0]?.content).toBe('<https://proxy.example/reel/1>');
  });

  it('replies with the proxy URL as content for a rewritten-url result', async () => {
    const { message, replies } = makeMessage();
    const result: RenderablePreviewResult = {
      kind: 'rewritten-url',
      url: 'https://fxtwitter.com/a/status/1',
      sourceUrl: 'https://x.com/a/status/1',
    };
    await renderPreview(message, result, makeTranslator());

    expect(replies).toHaveLength(1);
    const [payload] = replies;
    expect(payload?.content).toBe('https://fxtwitter.com/a/status/1');
    expect(payload?.allowedMentions).toEqual({ parse: [] });
    expect(payload?.embeds).toBeUndefined();
  });

  it('replies with an embed for a card result', async () => {
    const { message, replies } = makeMessage();
    const result: RenderablePreviewResult = {
      kind: 'card',
      card: {
        url: 'https://forum.gamer.com.tw/post/1',
        title: 'Title',
        description: 'Desc',
        imageUrl: 'https://cdn/og.jpg',
        siteName: 'Bahamut',
      },
      sourceUrl: 'https://forum.gamer.com.tw/post/1',
    };
    await renderPreview(message, result, makeTranslator());

    expect(replies).toHaveLength(1);
    const [payload] = replies;
    expect(payload?.embeds).toHaveLength(1);
    expect(payload?.allowedMentions).toEqual({ parse: [] });
  });

  it('retains an optional announcement only on the first gallery reply', async () => {
    const { message, replies } = makeMessage();
    await renderPreview(
      message,
      {
        kind: 'card',
        card: {
          url: 'https://www.facebook.com/page/posts/1',
          imageUrls: Array.from({ length: 5 }, (_, index) => `https://cdn.example/${index}.jpg`),
        },
        sourceUrl: 'https://www.facebook.com/page/posts/1',
      },
      makeTranslator(),
      { announcement: 'Source announcement' },
    );
    expect(replies).toHaveLength(2);
    expect(replies[0]?.content).toBe('Source announcement');
    expect(replies[1]?.content).toBeUndefined();
  });

  it('keeps every distinct HTTPS image in order across gallery replies', async () => {
    const { message, replies } = makeMessage();
    const images = Array.from({ length: 9 }, (_, index) => `https://cdn.example/${index}.jpg`);
    await renderPreview(
      message,
      {
        kind: 'card',
        card: {
          url: 'https://www.facebook.com/page/posts/1',
          title: 'Post title',
          siteName: 'Facebook',
          imageUrl: images[0],
          imageUrls: [images[0]!, 'http://cdn.example/unsafe.jpg', ...images],
        },
        sourceUrl: 'https://www.facebook.com/page/posts/1',
      },
      makeTranslator(),
    );

    expect(replies.map((reply) => reply.embeds?.length)).toEqual([4, 4, 1]);
    const embeds = replies.flatMap((reply) => reply.embeds ?? []) as {
      data: { image?: { url: string }; title?: string; color?: number; url?: string };
    }[];
    expect(embeds.map((embed) => embed.data.image?.url)).toEqual(images);
    expect(embeds[0]?.data.title).toBe('Post title');
    expect(
      embeds
        .slice(1)
        .every((embed) => embed.data.title === undefined && embed.data.color === undefined),
    ).toBe(true);
    expect(
      embeds.every((embed) => embed.data.url === 'https://www.facebook.com/page/posts/1'),
    ).toBe(true);
    expect(replies.every((reply) => reply.allowedMentions?.parse.length === 0)).toBe(true);
  });

  it('retains all card images when video delivery falls back', async () => {
    const { message, replies } = makeMessage();
    if (facebookResult.kind !== 'card') throw new Error('expected a card');
    const imageUrls = Array.from({ length: 5 }, (_, index) => `https://cdn.example/${index}.jpg`);
    await renderPreview(
      message,
      {
        ...facebookResult,
        card: { ...facebookResult.card, imageUrl: imageUrls[0], imageUrls },
      },
      makeTranslator(),
      { downloadVideo: vi.fn().mockResolvedValue(null) },
    );

    expect(replies.map((reply) => reply.embeds?.length)).toEqual([4, 1]);
    expect(replies[0]?.content).toBe('<https://proxy.example/reel/1>');
    expect(replies[1]?.content).toBeUndefined();
  });
});

describe('buildCardEmbed', () => {
  it('preserves long Facebook author titles so Discord can wrap them', () => {
    const title = 'Author and community '.repeat(10).trim();
    const embed = buildCardEmbed(
      {
        url: 'https://www.facebook.com/page/posts/1',
        authorName: title,
        siteName: 'Facebook',
      },
      makeTranslator(),
    );
    expect(embed.data.title).toBe(title);
    expect(embed.toJSON().title).toBe(title);
  });

  it('uses the information accent for generic preview cards', () => {
    const embed = buildCardEmbed(
      { url: 'https://example.test/post', title: 'Post', siteName: 'Example' },
      makeTranslator(),
    );
    expect(embed.toJSON()).toMatchObject({
      color: 0x5865f2,
      title: 'Post',
      url: 'https://example.test/post',
    });
  });

  it('links the Facebook author title to the post without adding a source link to the body', () => {
    const embed = buildCardEmbed(
      {
        url: 'https://www.facebook.com/reel/1',
        title: 'Reel title',
        authorName: 'Author',
        authorUrl: 'https://www.facebook.com/author',
        description: 'Post text',
        siteName: 'Facebook',
      },
      makeTranslator(),
    );
    expect(embed.data.author).toEqual({
      name: 'Facebook',
      icon_url: 'https://www.facebook.com/images/fb_icon_325x325.png',
    });
    expect(embed.data.color).toBe(0x1877f2);
    expect(embed.data.title).toBe('Author');
    expect(embed.data.url).toBe('https://www.facebook.com/reel/1');
    expect(embed.data.description).toBe('Post text');
    expect(embed.data.footer).toBeUndefined();
  });

  it('links a post title to the post when only an author URL is supplied', () => {
    const embed = buildCardEmbed(
      {
        url: 'https://www.facebook.com/reel/1',
        title: 'Reel title',
        authorUrl: 'https://www.facebook.com/author',
        siteName: 'Facebook',
      },
      makeTranslator(),
    );
    expect(embed.data.title).toBe('Reel title');
    expect(embed.data.url).toBe('https://www.facebook.com/reel/1');
  });

  it('keeps the supplied Facebook title when no author metadata is available', () => {
    const embed = buildCardEmbed(
      { url: 'https://www.facebook.com/reel/1', title: 'Reel title', siteName: 'Facebook' },
      makeTranslator(),
    );
    expect(embed.data.title).toBe('Reel title');
    expect(embed.data.url).toBe('https://www.facebook.com/reel/1');
  });

  it('keeps the post linked when Facebook title metadata is unavailable', () => {
    const embed = buildCardEmbed(
      { url: 'https://www.facebook.com/reel/1', title: '', siteName: 'Facebook' },
      makeTranslator(),
    );
    expect(embed.data.title).toBe('Facebook');
    expect(embed.data.url).toBe('https://www.facebook.com/reel/1');
    expect(embed.data.description).toBeUndefined();
  });

  it('renders Facebook likes, comments, and shares below the media', () => {
    const translator = makeTranslator();
    const embed = buildCardEmbed(
      {
        url: 'https://www.facebook.com/post/1',
        siteName: 'Facebook',
        engagement: { likes: 682, comments: 10, shares: 5 },
        imageUrl: 'https://cdn.example/post.jpg',
      },
      translator,
    );
    expect(embed.data.footer?.text).toBe('👍 682 · 💬 10 · 🔄 5');
    expect(translator.t).toHaveBeenCalledWith('replies:social_link_preview.engagement_likes', {
      count: 682,
    });
    expect(translator.t).toHaveBeenCalledWith('replies:social_link_preview.engagement_comments', {
      count: 10,
    });
    expect(translator.t).toHaveBeenCalledWith('replies:social_link_preview.engagement_shares', {
      count: 5,
    });
  });

  it('shows real zero counts and omits unavailable metrics', () => {
    const embed = buildCardEmbed(
      {
        url: 'https://www.facebook.com/post/1',
        siteName: 'Facebook',
        engagement: { likes: 0, shares: 3 },
      },
      makeTranslator(),
    );
    expect(embed.data.footer?.text).toBe('👍 0 · 🔄 3');
  });

  it('preserves compact counts without inventing exact totals', () => {
    const embed = buildCardEmbed(
      {
        url: 'https://www.facebook.com/post/1',
        siteName: 'Facebook',
        engagement: { likes: '1.2K', comments: '10m', shares: '0.5B' },
      },
      makeTranslator(),
    );
    expect(embed.data.footer?.text).toBe('👍 1.2K · 💬 10m · 🔄 0.5B');
  });

  it.each(['-1K', '1.2', '1,234', '10', '01K', '1e3', '1.2K extra', '<script>', ''])(
    'omits unrecognized formatted counts (%s)',
    (count) => {
      const embed = buildCardEmbed(
        {
          url: 'https://www.facebook.com/post/1',
          siteName: 'Facebook',
          engagement: { likes: count },
        },
        makeTranslator(),
      );
      expect(embed.data.footer).toBeUndefined();
    },
  );

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'omits invalid engagement counts (%s)',
    (count) => {
      const embed = buildCardEmbed(
        {
          url: 'https://www.facebook.com/post/1',
          siteName: 'Facebook',
          engagement: { likes: count, comments: 2, shares: count },
        },
        makeTranslator(),
      );
      expect(embed.data.footer?.text).toBe('💬 2');
    },
  );

  it('omits the Facebook footer when no valid statistics are available', () => {
    const embed = buildCardEmbed(
      {
        url: 'https://www.facebook.com/post/1',
        siteName: 'Facebook',
        engagement: { likes: -1 },
      },
      makeTranslator(),
    );
    expect(embed.data.footer).toBeUndefined();
  });

  it('truncates Facebook post text to 350 Unicode code points without splitting an emoji', () => {
    const embed = buildCardEmbed(
      {
        url: 'https://www.facebook.com/reel/1',
        description: '😀'.repeat(400),
        siteName: 'Facebook',
      },
      makeTranslator(),
    );
    const text = embed.data.description;
    expect(text).toBe(`${'😀'.repeat(347)}...`);
    expect(Array.from(text ?? '')).toHaveLength(350);
  });

  it('preserves Facebook post text at the 350-code-point limit', () => {
    const description = '😀'.repeat(350);
    const embed = buildCardEmbed(
      { url: 'https://www.facebook.com/reel/1', description, siteName: 'Facebook' },
      makeTranslator(),
    );
    expect(embed.data.description).toBe(description);
  });

  it('keeps emoji titles within the Discord UTF-16 limit', () => {
    const embed = buildCardEmbed(
      { url: 'https://www.facebook.com/reel/1', title: '😀'.repeat(200), siteName: 'Facebook' },
      makeTranslator(),
    );
    expect(embed.data.title).toBe(`${'😀'.repeat(126)}...`);
    expect(embed.data.title?.length).toBeLessThanOrEqual(256);
  });

  it('sets title (linked), description, image, and a translated footer', () => {
    const embed = buildCardEmbed(
      {
        url: 'https://forum.gamer.com.tw/post/1',
        title: 'Hello',
        description: 'World',
        imageUrl: 'https://cdn/og.jpg',
        siteName: 'Bahamut',
      },
      makeTranslator(),
    );
    expect(embed.data.title).toBe('Hello');
    expect(embed.data.url).toBe('https://forum.gamer.com.tw/post/1');
    expect(embed.data.description).toBe('World');
    expect(embed.data.image?.url).toBe('https://cdn/og.jpg');
    expect(embed.data.footer?.text).toBe('replies:social_link_preview.embed_footer|Bahamut');
  });

  it('omits optional fields that are absent', () => {
    const embed = buildCardEmbed({ url: 'https://forum.gamer.com.tw/post/1' }, makeTranslator());
    expect(embed.data.title).toBeUndefined();
    expect(embed.data.description).toBeUndefined();
    expect(embed.data.image).toBeUndefined();
    expect(embed.data.footer).toBeUndefined();
  });

  it('truncates an over-long title', () => {
    const long = 'x'.repeat(400);
    const embed = buildCardEmbed({ url: 'https://e/1', title: long }, makeTranslator());
    expect(embed.data.title?.length).toBe(256);
    expect(embed.data.title?.endsWith('...')).toBe(true);
  });
});

describe('renderPreview X post', () => {
  const post = (video?: boolean): RenderablePreviewResult => ({
    kind: 'post',
    sourceUrl: 'https://x.com/NASA/status/1',
    post: {
      url: 'https://x.com/NASA/status/1',
      text: 'hello',
      createdAt: 0,
      author: { name: 'NASA', handle: 'NASA', url: 'https://x.com/NASA' },
      images: ['https://pbs.twimg.com/1.jpg'],
      stats: {},
      ...(video === true
        ? {
            video: {
              thumbnailUrl: 'https://pbs.twimg.com/t.jpg',
              durationSeconds: 10,
              variants: [
                { url: 'https://video.twimg.com/high.mp4', bitrate: 2_000_000 },
                { url: 'https://video.twimg.com/low.mp4', bitrate: 500_000 },
              ],
            },
          }
        : {}),
    },
  });
  const uploadRejection = (): DiscordAPIError =>
    new DiscordAPIError(
      { code: 40005, message: 'Request entity too large' },
      40005,
      413,
      'POST',
      'https://discord.test/channels/1/messages',
      {},
    );

  it('replies with embeds for a post without video', async () => {
    const { message, replies } = makeMessage();
    const downloadVideo = vi.fn();
    await renderPreview(message, post(), makeTranslator(), { downloadVideo });
    expect(downloadVideo).not.toHaveBeenCalled();
    expect(replies).toHaveLength(1);
    expect(replies[0]?.embeds).toHaveLength(1);
    expect(replies[0]?.flags).toBeUndefined();
    expect(replies[0]?.allowedMentions).toEqual({ parse: [] });
  });

  it('uploads the best fitting video inside a Components V2 card', async () => {
    const { message, replies } = makeMessage();
    const data = Buffer.from('video');
    const downloadVideo = vi.fn().mockResolvedValue({ data, name: 'facebook.mp4' });
    await renderPreview(message, post(true), makeTranslator(), { downloadVideo });
    expect(downloadVideo).toHaveBeenCalledWith(
      'https://video.twimg.com/high.mp4',
      8 * 1024 * 1024,
      15_000,
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]?.flags).toBe(MessageFlags.IsComponentsV2);
    expect(replies[0]?.components).toHaveLength(1);
    expect(replies[0]?.embeds).toBeUndefined();
    expect(replies[0]?.files?.[0]?.name).toBe('x-video.mp4');
    expect(replies[0]?.files?.[0]?.attachment).toEqual(data);
  });

  it('tries the next encoding when a download fails', async () => {
    const { message, replies } = makeMessage();
    const downloadVideo = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ data: Buffer.from('v'), name: 'facebook.mp4' });
    await renderPreview(message, post(true), makeTranslator(), { downloadVideo });
    expect(downloadVideo).toHaveBeenLastCalledWith(
      'https://video.twimg.com/low.mp4',
      8 * 1024 * 1024,
      15_000,
    );
    expect(replies[0]?.flags).toBe(MessageFlags.IsComponentsV2);
  });

  it('tries the next encoding after an upload rejection, then falls back to embeds', async () => {
    const { message, replies } = makeMessage();
    vi.mocked(message.reply)
      .mockRejectedValueOnce(uploadRejection())
      .mockRejectedValueOnce(uploadRejection());
    const downloadVideo = vi.fn().mockResolvedValue({ data: Buffer.from('v'), name: 'a.mp4' });
    await renderPreview(message, post(true), makeTranslator(), { downloadVideo });
    expect(downloadVideo).toHaveBeenCalledTimes(2);
    expect(message.reply).toHaveBeenCalledTimes(3);
    expect(replies[0]?.flags).toBeUndefined();
    expect(replies[0]?.files).toBeUndefined();
    expect(replies[0]?.embeds).toHaveLength(1);
  });

  it('falls back to embeds when no encoding fits the upload cap', async () => {
    const { message, replies } = makeMessage();
    const downloadVideo = vi.fn();
    await renderPreview(message, post(true), makeTranslator(), {
      downloadVideo,
      maxVideoBytes: 1000,
    });
    expect(downloadVideo).not.toHaveBeenCalled();
    expect(replies[0]?.embeds).toHaveLength(1);
  });

  it('rethrows a reply failure that is not an upload rejection', async () => {
    const { message } = makeMessage();
    const failure = new Error('network down');
    vi.mocked(message.reply).mockRejectedValueOnce(failure);
    const downloadVideo = vi.fn().mockResolvedValue({ data: Buffer.from('v'), name: 'a.mp4' });
    await expect(
      renderPreview(message, post(true), makeTranslator(), { downloadVideo }),
    ).rejects.toBe(failure);
  });
});
