/** Validate editor input with the same keyword grammar the poller uses. */
import { feedKeywordRefusal, parseFeedKeyword } from '../../infra/social-feed';
import type { FeedSubscriptionFilterInput } from '../../persistence/repositories';
import {
  DEFAULT_FEED_MEDIA_FILTER,
  isFeedMediaFilter,
  type FeedMediaFilter,
} from '../../persistence/schemas/feed-subscription.schema';

/**
 * The filter to store, or the reply arguments refusing a keyword that
 * cannot be stored.
 */
type BuiltSubscriptionFilter =
  | { readonly kind: 'filter'; readonly filter: FeedSubscriptionFilterInput }
  | { readonly kind: 'refused'; readonly refusal: ReturnType<typeof feedKeywordRefusal> };

/**
 * Build the subscription filter.
 *
 * `media` is re-checked rather than trusted: Discord constrains it to
 * the declared choices, but the choices and the stored union are joined
 * only by matching string literals, so an unknown value falls back to
 * the default instead of being asserted into the type.
 *
 * The keyword is validated against the expression grammar here, before
 * any target is fetched, so a typo is answered at once rather than after
 * the upstream reads. An absent keyword omits the key entirely rather
 * than setting it to `undefined`, because the repository replaces the
 * stored filter wholesale.
 */
export const buildSubscriptionFilter = (
  media: string | undefined,
  keyword: string | undefined,
): BuiltSubscriptionFilter => {
  const parsed = parseFeedKeyword(keyword);
  if (parsed.kind === 'too_long' || parsed.kind === 'invalid') {
    return { kind: 'refused', refusal: feedKeywordRefusal(parsed) };
  }
  const resolvedMedia: FeedMediaFilter = isFeedMediaFilter(media)
    ? media
    : DEFAULT_FEED_MEDIA_FILTER;
  return {
    kind: 'filter',
    filter: {
      media: resolvedMedia,
      ...(parsed.kind === 'keyword' ? { keyword: parsed.keyword } : {}),
    },
  };
};
