/**
 * Read one X post from an FxTwitter-compatible JSON API
 * (`GET {base}/2/status/{id}`) and map it onto a neutral {@link SocialPost}.
 *
 * The API is a community-run service, so the base URLs are operator
 * configuration and tried in order; the first that answers with a valid
 * post wins. The schema validates only what is rendered and passes the
 * rest through, so an upstream field addition cannot fail the parse, and
 * optional counts that are missing or malformed are dropped rather than
 * failing the post. A response that does not carry a post at all is an
 * `INVALID_RESPONSE` on the Err rail, like any transport failure.
 *
 * `possibly_sensitive` is surfaced so the provider can leave such a post to
 * Discord's own unfurl, which applies the viewer's sensitive-media setting.
 */
import { z } from 'zod';

import { err, ok, type Result } from '../../core/result';

import { invalidResponseError } from './error-translator';
import type { OgClient } from './og-client';
import type { LinkPreviewFailure, SocialPost } from './types';

const PROVIDER_NAME = 'twitter';

/** A count the upstream may omit, null, or report as a non-number. */
const Count = z.number().int().nonnegative().optional().catch(undefined);

const AuthorSchema = z
  .object({
    name: z.string(),
    screen_name: z.string().min(1),
    url: z.string().url().optional().catch(undefined),
    avatar_url: z.string().url().optional().catch(undefined),
  })
  .passthrough();

const VideoSchema = z
  .object({
    thumbnail_url: z.string().url().optional().catch(undefined),
    duration: z.number().nonnegative().catch(0),
    formats: z
      .array(
        z
          .object({
            url: z.string().url(),
            container: z.string().optional(),
            bitrate: z.number().optional(),
          })
          .passthrough(),
      )
      .catch([]),
  })
  .passthrough();

const MediaSchema = z
  .object({
    photos: z
      .array(z.object({ url: z.string().url() }).passthrough())
      .optional()
      .catch(undefined),
    videos: z.array(VideoSchema).optional().catch(undefined),
  })
  .passthrough();

const QuoteSchema = z
  .object({
    url: z.string().url(),
    text: z.string().catch(''),
    author: AuthorSchema,
  })
  .passthrough();

const StatusSchema = z
  .object({
    url: z.string().url(),
    text: z.string().catch(''),
    created_timestamp: z.number(),
    author: AuthorSchema,
    replies: Count,
    reposts: Count,
    likes: Count,
    views: Count,
    possibly_sensitive: z.boolean().optional().catch(undefined),
    media: MediaSchema.optional().catch(undefined),
    quote: QuoteSchema.optional().catch(undefined),
  })
  .passthrough();

const EnvelopeSchema = z.object({ status: StatusSchema }).passthrough();

type Status = z.infer<typeof StatusSchema>;

/** A post plus the flag that decides whether a custom card may show it. */
export interface XStatus {
  readonly post: SocialPost;
  readonly sensitive: boolean;
}

const toPost = (status: Status): SocialPost => {
  const firstVideo = status.media?.videos?.[0];
  const variants = (firstVideo?.formats ?? [])
    .flatMap((format) =>
      format.container === 'mp4' && format.bitrate !== undefined && format.bitrate > 0
        ? [{ url: format.url, bitrate: format.bitrate }]
        : [],
    )
    .sort((a, b) => b.bitrate - a.bitrate);
  const author = status.author;
  return {
    url: status.url,
    text: status.text,
    createdAt: status.created_timestamp * 1000,
    author: {
      name: author.name,
      handle: author.screen_name,
      url: author.url ?? `https://x.com/${author.screen_name}`,
      ...(author.avatar_url === undefined ? {} : { avatarUrl: author.avatar_url }),
    },
    images: (status.media?.photos ?? []).map((photo) => photo.url),
    stats: {
      ...(status.replies === undefined ? {} : { replies: status.replies }),
      ...(status.reposts === undefined ? {} : { reposts: status.reposts }),
      ...(status.likes === undefined ? {} : { likes: status.likes }),
      ...(status.views === undefined ? {} : { views: status.views }),
    },
    ...(status.quote === undefined
      ? {}
      : {
          quote: {
            url: status.quote.url,
            text: status.quote.text,
            authorName: status.quote.author.name,
            authorHandle: status.quote.author.screen_name,
          },
        }),
    ...(firstVideo === undefined
      ? {}
      : {
          video: {
            ...(firstVideo.thumbnail_url === undefined
              ? {}
              : { thumbnailUrl: firstVideo.thumbnail_url }),
            durationSeconds: firstVideo.duration,
            variants,
          },
        }),
  };
};

/** Parse one API body. Pure + exported for unit tests. */
export const parseXStatus = (body: unknown): XStatus | undefined => {
  const parsed = EnvelopeSchema.safeParse(body);
  if (!parsed.success) return undefined;
  return {
    post: toPost(parsed.data.status),
    sensitive: parsed.data.status.possibly_sensitive === true,
  };
};

/**
 * Fetch post `id` from each base URL in order and return the first valid
 * post. Every failure is reported only if all bases fail; the last error
 * is the one returned.
 */
export const fetchXStatus = async (
  ogClient: OgClient,
  baseUrls: readonly string[],
  id: string,
  timeoutMs: number,
): Promise<Result<XStatus, LinkPreviewFailure>> => {
  let failure: LinkPreviewFailure = invalidResponseError(PROVIDER_NAME);
  for (const base of baseUrls) {
    const body = await ogClient.fetchJson(
      `${base.replace(/\/+$/, '')}/2/status/${id}`,
      PROVIDER_NAME,
      timeoutMs,
    );
    if (!body.ok) {
      failure = body.error;
      continue;
    }
    const status = parseXStatus(body.value);
    if (status !== undefined) return ok(status);
    failure = invalidResponseError(PROVIDER_NAME);
  }
  return err(failure);
};
