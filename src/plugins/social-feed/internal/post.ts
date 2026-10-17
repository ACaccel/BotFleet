/**
 * Turn a selected {@link FeedPost} into a Discord message.
 *
 * X uses the shared hybrid preview renderer. Other platforms and failed
 * preview preparation retain the localized proxy-link announcement.
 * Announcements and previews share one send, so delivery-based cursors
 * never advance after only the announcement reached Discord.
 *
 * Every send uses `allowedMentions: { parse: [] }` so post text can
 * never trigger an @everyone / @role ping.
 */
import type { SendableChannels } from 'discord.js';
import { escapeMarkdown } from 'discord.js';

import type { Translator } from '../../../core/i18n';
import type { FeedPlatform, FeedPost, FeedPreview } from '../../../infra/social-feed';
import { logError, type Logger } from '../../../core/logger';
import { renderPreviewTo, type PreviewRenderOptions } from '../../../infra/discord/social-preview';

const NO_MENTIONS = { parse: [] as const };

/** Compose the announcement line for one post. */
export const buildFeedMessage = (
  translator: Translator,
  platform: FeedPlatform,
  post: FeedPost,
  url: string = platform.toEmbedUrl(post),
): string => {
  const announcement = translator.t('replies:feed.post', {
    author: post.authorAccount,
    platform: platform.displayName,
    url,
  });
  if (platform.subscriptionScope !== 'source' || post.text === '') return announcement;
  // Forum unfurls may show the opening floor rather than the linked reply.
  const body = escapeMarkdown(post.text, { maskedLink: true });
  const available = Math.max(0, 1900 - announcement.length);
  if (available === 0) return announcement;
  const excerpt = body.length <= available ? body : `${body.slice(0, available - 1)}…`;
  return `${announcement}\n${excerpt}`;
};

/** Preview failure degrades to a link; Discord send failures still propagate. */
export const prepareFeedPreview = async (
  platform: FeedPlatform,
  post: FeedPost,
  logger: Logger,
): Promise<FeedPreview | undefined> => {
  if (platform.buildPreview === undefined) return undefined;
  try {
    const result = await platform.buildPreview(post, logger);
    if (!result.ok) {
      logError(logger, null, result.error);
      return undefined;
    }
    return result.value ?? undefined;
  } catch (error) {
    logError(logger, null, error);
    return undefined;
  }
};

/** Post one announcement. The caller has already checked sendability. */
export const sendFeedPost = async (
  channel: SendableChannels,
  content: string,
  preview?: {
    readonly result: FeedPreview;
    readonly translator: Translator;
    readonly options?: PreviewRenderOptions;
  },
): Promise<void> => {
  if (preview !== undefined) {
    await renderPreviewTo((payload) => channel.send(payload), preview.result, preview.translator, {
      ...preview.options,
      announcement: content,
    });
    return;
  }
  await channel.send({ content, allowedMentions: NO_MENTIONS });
};
