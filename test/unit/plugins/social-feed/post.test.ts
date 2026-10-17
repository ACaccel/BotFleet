/**
 * Unit tests for the social-feed message builder.
 *
 * The catalog cases deliberately use the REAL on-disk translator rather
 * than a stub: the i18n gates only check that the two locale files agree
 * with each other, so nothing else in the suite would notice if the key
 * this code asks for were renamed or removed. A stubbed translator would
 * happily echo a dead key.
 */
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import {
  MessageFlags,
  ComponentType,
  type SendableChannels,
  type MessageCreateOptions,
  type EmbedBuilder,
  type ContainerBuilder,
} from 'discord.js';

import { loadCatalogResources } from '../../../../src/core/i18n/catalog-loader';
import { I18NextTranslator } from '../../../../src/core/i18n/i18next-translator';
import type { Translator } from '../../../../src/core/i18n';
import { buildFeedMessage, sendFeedPost } from '../../../../src/plugins/social-feed/internal';
import { buildFakeFeedPlatform, buildFeedPost } from '../../../fixtures/social-feed/fake-platform';
import { XPlatform } from '../../../../src/infra/social-feed';
import { prepareFeedPreview } from '../../../../src/plugins/social-feed/internal/post';
import { err, ok } from '../../../../src/core/result';
import { invalidResponseError, type SocialPost } from '../../../../src/infra/link-preview';
import { silentLogger } from '../../../fixtures/runtime';

const LOCALES_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'i18n', 'locales');

const realTranslator = async (): Promise<Translator> =>
  I18NextTranslator.create(loadCatalogResources({ localesDir: LOCALES_DIR }));

/** A channel reduced to the `send` spy; only that method is read by the sender. */
const sendableChannel = (send: unknown): SendableChannels =>
  ({ send }) as unknown as SendableChannels;

const samplePost = buildFeedPost({
  id: '2092744659667673582',
  authorAccount: 'someaccount',
  createdTimestamp: 1_787_784_182,
  url: 'https://x.com/someaccount/status/2092744659667673582',
  media: [{ kind: 'photo', url: 'https://pbs.twimg.com/media/a.jpg' }],
});

const { platform: fakePlatform } = buildFakeFeedPlatform();

describe('buildFeedMessage', () => {
  it('includes thread floor text because forum unfurls can show the opening post', async () => {
    const message = buildFeedMessage(
      await realTranslator(),
      { ...fakePlatform, subscriptionScope: 'source' },
      { ...samplePost, text: 'D4Y7P9R3T @everyone' },
    );
    expect(message).toContain('D4Y7P9R3T');
    expect(message).toContain(samplePost.authorAccount);
    expect(message).toContain(fakePlatform.toEmbedUrl(samplePost));
  });

  it('bounds the thread excerpt within one Discord message', async () => {
    const message = buildFeedMessage(
      await realTranslator(),
      { ...fakePlatform, subscriptionScope: 'source' },
      { ...samplePost, text: '*'.repeat(10_000) },
    );
    expect(message.length).toBeLessThanOrEqual(2000);
  });
  it('resolves the real catalog key, leaving no placeholder behind', async () => {
    const message = buildFeedMessage(await realTranslator(), fakePlatform, samplePost);

    // A missing key makes i18next echo the key itself; an unfilled slot
    // leaves the raw {{...}} token in the output. Both must be absent.
    expect(message).not.toContain('feed.post');
    expect(message).not.toContain('{{');
  });

  it('interpolates the author, the platform, and the link the platform embeds', async () => {
    const message = buildFeedMessage(await realTranslator(), fakePlatform, samplePost);

    expect(message).toContain('someaccount');
    expect(message).toContain(fakePlatform.displayName);
    expect(message).toContain(fakePlatform.toEmbedUrl(samplePost));
  });

  it('posts the platform’s embed link rather than the canonical permalink', async () => {
    // The whole point of asking the platform: X's own host does not
    // unfurl into a playable video, the proxy host does.
    const x = new XPlatform({ timeoutMs: 1000, embedProxyHost: 'fxtwitter.com' });
    const message = buildFeedMessage(await realTranslator(), x, samplePost);

    expect(message).toContain('https://fxtwitter.com/someaccount/status/2092744659667673582');
    expect(message).not.toContain('https://x.com/');
  });

  it('does not HTML-escape the URL', async () => {
    // The catalog runs with `escapeValue: false`; if that ever flips, a
    // query-bearing URL would arrive with &amp; and break the unfurl.
    const withQuery = buildFeedPost({ ...samplePost, url: `${samplePost.url}?s=20&t=abc` });
    const x = new XPlatform({ timeoutMs: 1000, embedProxyHost: 'fxtwitter.com' });
    const message = buildFeedMessage(await realTranslator(), x, withQuery);

    expect(message).toContain('?s=20&t=abc');
    expect(message).not.toContain('&amp;');
  });
});

describe('sendFeedPost', () => {
  const socialPost: SocialPost = {
    url: samplePost.url,
    text: 'New post @everyone',
    createdAt: samplePost.createdTimestamp * 1000,
    author: { name: 'Some Account', handle: 'someaccount', url: 'https://x.com/someaccount' },
    images: ['https://pbs.twimg.com/1.jpg', 'https://pbs.twimg.com/2.jpg'],
    stats: { likes: 12 },
  };
  const announcement = `New post: <${samplePost.url}>`;
  const videoPost: SocialPost = {
    ...socialPost,
    images: [],
    video: {
      durationSeconds: 1,
      thumbnailUrl: 'https://pbs.twimg.com/thumb.jpg',
      variants: [{ url: 'https://video.twimg.com/a.mp4', bitrate: 1000 }],
    },
  };

  it('sends the announcement and all X photos together', async () => {
    const send = vi
      .fn<(payload: MessageCreateOptions) => Promise<undefined>>()
      .mockResolvedValue(undefined);
    await sendFeedPost(sendableChannel(send), announcement, {
      result: { kind: 'post', post: socialPost, sourceUrl: samplePost.url },
      translator: await realTranslator(),
    });
    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]![0];
    expect(payload.content).toBe(announcement);
    expect((payload.embeds as EmbedBuilder[]).map((embed) => embed.data.image?.url)).toEqual(
      socialPost.images,
    );
    expect((payload.embeds?.[0] as EmbedBuilder).data.description).toBe(socialPost.text);
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it('sends only the proxy announcement for a rewritten preview', async () => {
    const send = vi.fn();
    await sendFeedPost(sendableChannel(send), 'Announcement https://vx.example/post', {
      result: {
        kind: 'rewritten-url',
        url: 'https://vx.example/post',
        sourceUrl: samplePost.url,
      },
      translator: await realTranslator(),
    });
    expect(send).toHaveBeenCalledExactlyOnceWith({
      content: 'Announcement https://vx.example/post',
      allowedMentions: { parse: [] },
    });
  });

  it('includes the announcement inside an uploaded-video V2 card without content', async () => {
    const send = vi
      .fn<(payload: MessageCreateOptions) => Promise<undefined>>()
      .mockResolvedValue(undefined);
    await sendFeedPost(sendableChannel(send), announcement, {
      result: { kind: 'post', post: videoPost, sourceUrl: samplePost.url },
      translator: await realTranslator(),
      options: {
        downloadVideo: vi.fn().mockResolvedValue({ data: Buffer.from('video'), name: 'v.mp4' }),
      },
    });
    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]![0];
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(payload.content).toBeUndefined();
    expect(payload.files).toHaveLength(1);
    const container = (payload.components?.[0] as ContainerBuilder).toJSON();
    expect(container.components[0]).toEqual({
      type: ComponentType.TextDisplay,
      content: announcement,
    });
    expect(container.components.at(-1)).toMatchObject({
      type: ComponentType.MediaGallery,
      items: [{ media: { url: 'attachment://x-video.mp4' } }],
    });
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it('retains the announcement and thumbnail if no video can be uploaded', async () => {
    const send = vi
      .fn<(payload: MessageCreateOptions) => Promise<undefined>>()
      .mockResolvedValue(undefined);
    await sendFeedPost(sendableChannel(send), announcement, {
      result: { kind: 'post', post: videoPost, sourceUrl: samplePost.url },
      translator: await realTranslator(),
      options: { downloadVideo: vi.fn().mockResolvedValue(null) },
    });
    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]![0];
    expect(payload.content).toBe(announcement);
    expect(payload.files).toBeUndefined();
    expect((payload.embeds?.[0] as EmbedBuilder).data.image?.url).toBe(
      videoPost.video?.thumbnailUrl,
    );
  });

  it('propagates Discord send failures without sending a second fallback announcement', async () => {
    const error = new Error('Missing Permissions');
    const send = vi.fn().mockRejectedValue(error);
    await expect(
      sendFeedPost(sendableChannel(send), announcement, {
        result: { kind: 'post', post: socialPost, sourceUrl: samplePost.url },
        translator: await realTranslator(),
      }),
    ).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('suppresses every mention, so post text cannot ping a role', async () => {
    const send = vi.fn(async () => undefined);
    const channel = sendableChannel(send);

    await sendFeedPost(channel, 'hello @everyone');

    expect(send).toHaveBeenCalledWith({
      content: 'hello @everyone',
      allowedMentions: { parse: [] },
    });
  });
});

describe('prepareFeedPreview', () => {
  it.each(['null', 'error', 'throw'] as const)(
    'retains link delivery when preview preparation returns %s',
    async (outcome) => {
      const { platform } = buildFakeFeedPlatform();
      platform.buildPreview = vi.fn(async () => {
        if (outcome === 'throw') throw new Error('Upstream unavailable');
        return outcome === 'null' ? ok(null) : err(invalidResponseError('twitter'));
      });
      const logger = silentLogger();
      const error = vi.spyOn(logger, 'error');
      expect(await prepareFeedPreview(platform, samplePost, logger)).toBeUndefined();
      expect(error).toHaveBeenCalledTimes(outcome === 'null' ? 0 : 1);
    },
  );
});
