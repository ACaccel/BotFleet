/**
 * Unit tests for the custom X card layouts: the classic embed gallery
 * (author, escaped text, quote, compact counts, timestamp, up to four
 * photos), its video fallback (thumbnail plus a link to the video), the
 * Components V2 card around an uploaded video, and the choice of which
 * video encodings to try.
 */
import { describe, expect, it, vi } from 'vitest';
import { ComponentType } from 'discord.js';

import type { Translator } from '../../../../src/core/i18n';
import type { SocialPost } from '../../../../src/infra/link-preview';
import {
  buildPostContainer,
  buildPostEmbeds,
  pickVideoVariants,
} from '../../../../src/plugins/social-link-preview/internal/render-post';

/** Echoes the key's last segment and its params, so assertions see both. */
const translator = {
  t: vi.fn((key: string, params?: Record<string, unknown>) => {
    const name = key.split('.').pop() ?? key;
    return params === undefined ? name : `${name}(${Object.values(params).join(',')})`;
  }),
} as unknown as Translator;

const post = (extra: Partial<SocialPost> = {}): SocialPost => ({
  url: 'https://x.com/NASA/status/1',
  text: 'Welcome home!',
  createdAt: 1_791_840_744_000,
  author: {
    name: 'NASA',
    handle: 'NASA',
    url: 'https://x.com/NASA',
    avatarUrl: 'https://pbs.twimg.com/a.jpg',
  },
  images: [],
  stats: { replies: 196, reposts: 847, likes: 6500, views: 1_500_000 },
  ...extra,
});

describe('buildPostEmbeds', () => {
  it('shows the author, text, compact counts and post time', () => {
    const [embed, ...rest] = buildPostEmbeds(post(), translator);
    expect(rest).toEqual([]);
    expect(embed?.data.color).toBe(0x1d9bf0);
    expect(embed?.data.author).toEqual({
      name: 'NASA (@NASA)',
      url: 'https://x.com/NASA',
      icon_url: 'https://pbs.twimg.com/a.jpg',
    });
    expect(embed?.data.url).toBe('https://x.com/NASA/status/1');
    expect(embed?.data.description).toBe('Welcome home!');
    expect(embed?.data.footer?.text).toBe(
      'X · post_replies(196) · post_reposts(847) · post_likes(6.5K) · post_views(1.5M)',
    );
    expect(embed?.data.timestamp).toBe(new Date(1_791_840_744_000).toISOString());
  });

  it('omits unreported counts and falls back to the site label', () => {
    const [embed] = buildPostEmbeds(post({ stats: {} }), translator);
    expect(embed?.data.footer?.text).toBe('X');
  });

  it('spreads up to four https photos over embeds sharing the post URL', () => {
    const images = ['1', '2', '3', '4', '5'].map((n) => `https://pbs.twimg.com/${n}.jpg`);
    const embeds = buildPostEmbeds(
      post({ images: ['http://insecure/0.jpg', ...images] }),
      translator,
    );
    expect(embeds.map((e) => e.data.image?.url)).toEqual(images.slice(0, 4));
    expect(embeds.every((e) => e.data.url === 'https://x.com/NASA/status/1')).toBe(true);
    expect(embeds[0]?.data.color).toBe(0x1d9bf0);
    expect(embeds.slice(1).every((embed) => embed.data.color === undefined)).toBe(true);
  });

  it('escapes markdown in the post text', () => {
    const [embed] = buildPostEmbeds(
      post({ text: '# big\n||spoiler|| **bold** [x.com](https://evil.test)' }),
      translator,
    );
    expect(embed?.data.description).toBe(
      '\\# big\n\\|\\|spoiler\\|\\| \\*\\*bold\\*\\* \\[x.com](https://evil.test)',
    );
  });

  it('appends the quoted post as a block quote', () => {
    const [embed] = buildPostEmbeds(
      post({
        quote: {
          url: 'https://x.com/s/status/2',
          text: 'line one\nline two',
          authorName: 'Someone',
          authorHandle: 's',
        },
      }),
      translator,
    );
    expect(embed?.data.description).toBe(
      'Welcome home!\n\npost_quote(Someone,s,https://x.com/s/status/2)\n> line one\n> line two',
    );
  });

  it('shows a video post with its thumbnail and a link to the video', () => {
    const [embed] = buildPostEmbeds(
      post({
        video: { thumbnailUrl: 'https://pbs.twimg.com/t.jpg', durationSeconds: 10, variants: [] },
      }),
      translator,
    );
    expect(embed?.data.image?.url).toBe('https://pbs.twimg.com/t.jpg');
    expect(embed?.data.description).toBe(
      'Welcome home!\n\npost_watch_video(https://x.com/NASA/status/1)',
    );
  });
});

describe('buildPostContainer', () => {
  it('puts the text beside the avatar, then the video, then the counts', () => {
    const json = buildPostContainer(post(), translator, 'attachment://x-video.mp4').toJSON();
    expect(json.accent_color).toBe(0x1d9bf0);
    const [section, gallery, footer] = json.components;
    expect(section?.type).toBe(ComponentType.Section);
    if (section?.type === ComponentType.Section) {
      expect(section.components[0]?.content).toBe(
        '**[NASA](https://x.com/NASA)** @NASA\nWelcome home!',
      );
      expect(section.accessory).toMatchObject({ media: { url: 'https://pbs.twimg.com/a.jpg' } });
    }
    expect(gallery).toMatchObject({
      type: ComponentType.MediaGallery,
      items: [{ media: { url: 'attachment://x-video.mp4' } }],
    });
    expect(footer).toMatchObject({
      type: ComponentType.TextDisplay,
      content:
        '-# post_replies(196) · post_reposts(847) · post_likes(6.5K) · post_views(1.5M) · <t:1791840744:f> · post_view_original(https://x.com/NASA/status/1)',
    });
  });

  it('uses a plain text block when the author has no avatar', () => {
    const { avatarUrl: _omitted, ...author } = post().author;
    const json = buildPostContainer(post({ author }), translator, 'attachment://v.mp4').toJSON();
    expect(json.components[0]?.type).toBe(ComponentType.TextDisplay);
  });
});

describe('pickVideoVariants', () => {
  const video = {
    durationSeconds: 100,
    variants: [
      { url: 'https://v/high.mp4', bitrate: 2_000_000 },
      { url: 'https://v/mid.mp4', bitrate: 700_000 },
      { url: 'https://v/low.mp4', bitrate: 250_000 },
      { url: 'https://v/tiny.mp4', bitrate: 100_000 },
    ],
  };

  it('keeps the encodings estimated to fit, best first, at most two', () => {
    // 8 MiB cap with a 90% margin (7.5 MB): high = 25 MB and mid = 8.75 MB are over.
    expect(pickVideoVariants(video, 8 * 1024 * 1024).map((v) => v.url)).toEqual([
      'https://v/low.mp4',
      'https://v/tiny.mp4',
    ]);
  });

  it('returns nothing when no encoding fits', () => {
    expect(pickVideoVariants(video, 100_000)).toEqual([]);
  });
});
