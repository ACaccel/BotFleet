/**
 * Turns `/feed subscribe`'s two filter option values into the shape the
 * repository stores.
 *
 * Takes the values, not the interaction: reading options is the
 * handler's job, and a helper that reached into an interaction could
 * only be tested by building one. This way every option combination is
 * one function call.
 */
import type { FeedSubscriptionFilterInput } from '../../../persistence/repositories';
import {
  DEFAULT_FEED_MEDIA_FILTER,
  isFeedMediaFilter,
  type FeedMediaFilter,
} from '../../../persistence/schemas/feed-subscription.schema';

/** Matches the schema's `maxlength` on the stored `filter.keyword`. */
const MAX_KEYWORD_LENGTH = 100;

/**
 * Build the subscription filter.
 *
 * `media` is re-checked rather than trusted: Discord constrains it to
 * the declared choices, but the choices and the stored union are joined
 * only by matching string literals, so an unknown value falls back to
 * the default instead of being asserted into the type.
 *
 * An over-long keyword is truncated rather than rejected. No zod schema
 * sits on this path, so the only other enforcement is the schema's
 * `maxlength` — which would surface as a database validation error
 * after the account had already been fetched upstream. 100 characters
 * is far beyond what a substring match needs.
 *
 * A blank or whitespace-only keyword counts as "not given", so clearing
 * the option and omitting it mean the same thing. The key is omitted
 * entirely rather than set to `undefined`, because the repository
 * replaces the stored filter wholesale.
 */
export const buildSubscriptionFilter = (
  media: string | undefined,
  keyword: string | undefined,
): FeedSubscriptionFilterInput => {
  const trimmed = keyword?.trim().slice(0, MAX_KEYWORD_LENGTH) ?? '';
  const resolvedMedia: FeedMediaFilter = isFeedMediaFilter(media)
    ? media
    : DEFAULT_FEED_MEDIA_FILTER;
  return {
    media: resolvedMedia,
    ...(trimmed === '' ? {} : { keyword: trimmed }),
  };
};
