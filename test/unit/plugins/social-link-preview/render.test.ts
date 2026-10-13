/**
 * Unit tests for {@link renderPreview} / {@link buildCardEmbed}: the
 * discriminated-union reply dispatch and embed assembly. A minimal fake
 * Message captures the reply payload; the translator is stubbed.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DiscordAPIError,
  HTTPError,
  MessageFlags,
  type AttachmentBuilder,
  type Message,
} from 'discord.js';

import {
  renderPreview,
  buildCardEmbed,
} from '../../../../src/plugins/social-link-preview/internal/render';
import type { Translator } from '../../../../src/core/i18n';
import type { LinkPreviewResult } from '../../../../src/infra/link-preview';

const makeTranslator = (): Translator =>
  ({
    t: vi.fn((key: string, params?: { provider?: string; count?: number | string }) => {
      const statistics: Record<string, string> = {
        'replies:social_link_preview.engagement_likes': '👍',
        'replies:social_link_preview.engagement_comments': '💬',
        'replies:social_link_preview.engagement_shares': '🔄',
      };
      const icon = statistics[key];
      return icon === undefined ? `${key}|${params?.provider ?? ''}` : `${icon} ${params?.count}`;
    }),
  }) as unknown as Translator;

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
  const message = {
    reply: vi.fn(async (payload: ReplyPayload) => {
      replies.push(payload);
      return {} as Message;
    }),
  } as unknown as Message;
  return { message, replies };
};

describe('renderPreview', () => {
  const facebookResult: LinkPreviewResult = {
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

  it('sends the Facebook card and downloaded video together without the poster', async () => {
    const { message, replies } = makeMessage();
    const data = Buffer.from('video');
    const downloadVideo = vi.fn().mockResolvedValue({ data, name: 'preview.mp4' });
    await renderPreview(message, facebookResult, makeTranslator(), { downloadVideo });

    expect(downloadVideo).toHaveBeenCalledWith(
      'https://cdn.example/video.mp4',
      8 * 1024 * 1024,
      15_000,
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]?.files?.[0]?.attachment).toEqual(data);
    expect(replies[0]?.files?.[0]?.name).toBe('preview.mp4');
    expect((replies[0]?.embeds?.[0] as { data: { image?: unknown } }).data.image).toBeUndefined();
    expect(replies[0]?.allowedMentions).toEqual({ parse: [] });
    expect(replies[0]?.content).toBeUndefined();
  });

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
    const result: LinkPreviewResult = {
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
    const result: LinkPreviewResult = {
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
});

describe('buildCardEmbed', () => {
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
  const post = (video?: boolean): LinkPreviewResult => ({
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
