/**
 * The failure raised when a member names a platform this bot has no
 * adapter for.
 *
 * A `FeedError` rather than a hand-rendered reply, so the refusal takes
 * the same route as every other boundary failure: `replyForError`
 * renders its `messageKey` for the user *and* writes the operator log
 * line. An operator who forgot a `social_feed.platforms` block would
 * otherwise only ever hear about it from a member.
 */
import { FeedError } from '../../../core/errors';
import { feedPlatformDisplayName } from '../../feed-platform-name';

export const platformNotConfiguredError = (id: string): FeedError<{ platform: string }> =>
  new FeedError({
    code: 'FEED_PLATFORM_NOT_CONFIGURED',
    messageKey: 'errors:feed.platform_not_configured',
    messageParams: { platform: feedPlatformDisplayName(id) },
    context: { operation: 'feed_subscribe', input: { platform: id } },
  });
