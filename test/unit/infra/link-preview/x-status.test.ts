/**
 * Unit tests for the X post API client: {@link parseXStatus} maps an
 * FxTwitter v2 body onto a neutral post, tolerating missing or malformed
 * optional fields, and {@link fetchXStatus} walks the configured bases in
 * order until one returns a valid post.
 */
import { describe, expect, it, vi } from 'vitest';

import { err, isErr, isOk, ok } from '../../../../src/core/result';
import { invalidResponseError, type OgClient } from '../../../../src/infra/link-preview';
import { fetchXStatus, parseXStatus } from '../../../../src/infra/link-preview/x-status';

/** A trimmed real `/2/status/<id>` body. */
const body = (status: Record<string, unknown> = {}): unknown => ({
  code: 200,
  status: {
    url: 'https://x.com/NASA/status/1',
    text: 'Welcome home!',
    created_timestamp: 1_791_840_744,
    author: {
      name: 'NASA',
      screen_name: 'NASA',
      url: 'https://x.com/NASA',
      avatar_url: 'https://pbs.twimg.com/a.jpg',
    },
    replies: 196,
    reposts: 847,
    likes: 6500,
    views: 1_500_000,
    possibly_sensitive: false,
    media: {
      photos: [{ url: 'https://pbs.twimg.com/1.jpg' }, { url: 'https://pbs.twimg.com/2.jpg' }],
    },
    ...status,
  },
});

describe('parseXStatus', () => {
  it('maps a post with photos, counts and author', () => {
    expect(parseXStatus(body())).toEqual({
      sensitive: false,
      post: {
        url: 'https://x.com/NASA/status/1',
        text: 'Welcome home!',
        createdAt: 1_791_840_744_000,
        author: {
          name: 'NASA',
          handle: 'NASA',
          url: 'https://x.com/NASA',
          avatarUrl: 'https://pbs.twimg.com/a.jpg',
        },
        images: ['https://pbs.twimg.com/1.jpg', 'https://pbs.twimg.com/2.jpg'],
        stats: { replies: 196, reposts: 847, likes: 6500, views: 1_500_000 },
      },
    });
  });

  it('keeps only MP4 encodings with a bitrate, highest first', () => {
    const parsed = parseXStatus(
      body({
        media: {
          videos: [
            {
              thumbnail_url: 'https://pbs.twimg.com/t.jpg',
              duration: 108.9,
              formats: [
                { url: 'https://video.twimg.com/p.m3u8', container: 'm3u8' },
                { url: 'https://video.twimg.com/low.mp4', container: 'mp4', bitrate: 256_000 },
                { url: 'https://video.twimg.com/high.mp4', container: 'mp4', bitrate: 2_176_000 },
              ],
            },
          ],
        },
      }),
    );
    expect(parsed?.post.images).toEqual([]);
    expect(parsed?.post.video).toEqual({
      thumbnailUrl: 'https://pbs.twimg.com/t.jpg',
      durationSeconds: 108.9,
      variants: [
        { url: 'https://video.twimg.com/high.mp4', bitrate: 2_176_000 },
        { url: 'https://video.twimg.com/low.mp4', bitrate: 256_000 },
      ],
    });
  });

  it('maps a quoted post', () => {
    const parsed = parseXStatus(
      body({
        quote: {
          url: 'https://x.com/someone/status/2',
          text: 'quoted text',
          author: { name: 'Someone', screen_name: 'someone' },
        },
      }),
    );
    expect(parsed?.post.quote).toEqual({
      url: 'https://x.com/someone/status/2',
      text: 'quoted text',
      authorName: 'Someone',
      authorHandle: 'someone',
    });
  });

  it('drops malformed optional fields instead of rejecting the post', () => {
    const parsed = parseXStatus(
      body({
        views: null,
        likes: 'many',
        media: 'broken',
        author: { name: 'NASA', screen_name: 'NASA', avatar_url: 'not a url' },
      }),
    );
    expect(parsed?.post.stats).toEqual({ replies: 196, reposts: 847 });
    expect(parsed?.post.images).toEqual([]);
    expect(parsed?.post.author).toEqual({
      name: 'NASA',
      handle: 'NASA',
      url: 'https://x.com/NASA',
    });
  });

  it('flags a possibly sensitive post', () => {
    expect(parseXStatus(body({ possibly_sensitive: true }))?.sensitive).toBe(true);
  });

  it('rejects a body without a post', () => {
    expect(parseXStatus({ code: 404, message: 'NOT_FOUND' })).toBeUndefined();
    expect(parseXStatus(body({ url: undefined }))).toBeUndefined();
    expect(parseXStatus('not json')).toBeUndefined();
  });
});

describe('fetchXStatus', () => {
  const client = (
    answers: Record<string, unknown>,
  ): { client: OgClient; fetchJson: ReturnType<typeof vi.fn> } => {
    const fetchJson = vi.fn(async (url: string) =>
      url in answers ? answers[url] : err(invalidResponseError('twitter')),
    );
    return { client: { fetchJson } as unknown as OgClient, fetchJson };
  };

  it('reads the v2 status endpoint, trimming a trailing slash from the base', async () => {
    const { client: og, fetchJson } = client({ 'https://api.example/2/status/1': ok(body()) });
    const result = await fetchXStatus(og, ['https://api.example/'], '1', 1000);
    expect(isOk(result)).toBe(true);
    expect(fetchJson).toHaveBeenCalledWith('https://api.example/2/status/1', 'twitter', 1000);
  });

  it('moves to the next base after a failure or an invalid body', async () => {
    const { client: og, fetchJson } = client({
      'https://b.example/2/status/1': ok({ code: 500 }),
      'https://c.example/2/status/1': ok(body()),
    });
    const result = await fetchXStatus(
      og,
      ['https://a.example', 'https://b.example', 'https://c.example'],
      '1',
      1000,
    );
    expect(isOk(result)).toBe(true);
    expect(fetchJson).toHaveBeenCalledTimes(3);
  });

  it('returns Err when every base fails', async () => {
    const { client: og } = client({});
    const result = await fetchXStatus(og, ['https://a.example'], '1', 1000);
    expect(isErr(result)).toBe(true);
  });
});
