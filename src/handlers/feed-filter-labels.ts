/**
 * The words every `/feed_*` surface uses for a subscription's filter.
 *
 * `/feed list` describes the filter a subscription already has, and
 * `/feed subscribe` echoes back the filter it has just written; a member
 * comparing the two is comparing the same subscription, so the two
 * surfaces must not spell it differently. Keeping the labels — and the
 * separator between them — in one module is what makes that structural
 * rather than a convention two files have to remember.
 *
 * Pure: it takes a filter and a translate function, so every
 * combination is testable without an interaction or a catalog.
 */
import type { BoundTranslate } from '../core/i18n';
import type { FeedSubscriptionFilter } from '../persistence/schemas/feed-subscription.schema';

/**
 * A filter as either caller holds it: `/feed list` reads one off a
 * stored document and `/feed subscribe` has just built one for the
 * repository. Both shapes satisfy this one, and labelling only reads —
 * hence `Readonly`. Exported so a module rendering a filter names the
 * contract it is describing rather than the repository's write input.
 */
export type DescribableFeedFilter = Readonly<FeedSubscriptionFilter>;

/**
 * Separator between the annotations trailing a feed line.
 *
 * A constant rather than a catalog key, unlike `feed.permission_separator`:
 * that one is list punctuation each locale spells its own way, whereas this
 * is a visual divider inside one line, and both feed surfaces have to draw
 * it identically for the two readings to look like the same filter.
 */
export const FEED_FILTER_SEPARATOR = ' · ';

/**
 * Labels for this filter.
 *
 * The media filter is always shown, default included: a reader cannot
 * tell an unlabelled line apart from one whose label they do not know,
 * and the default is a real choice (text-only posts are dropped) rather
 * than an absence of one. The keyword is shown only when set, because
 * "no keyword" genuinely means no narrowing.
 */
export const describeFeedFilter = (
  filter: DescribableFeedFilter,
  t: BoundTranslate,
): readonly string[] => {
  const labels: string[] = [t(`replies:feed.filter_media.${filter.media}`)];
  if (filter.keyword !== undefined && filter.keyword !== '') {
    // The keyword is whatever a member typed and the translator
    // interpolates without escaping, so a backtick would break out of
    // the code span the line around it draws. Its length is already
    // bounded where the filter is built.
    labels.push(t('replies:feed.filter_keyword', { keyword: filter.keyword.replace(/`/g, ' ') }));
  }
  return labels;
};

/** The same labels as one phrase, for a line that carries nothing else. */
export const formatFeedFilter = (filter: DescribableFeedFilter, t: BoundTranslate): string =>
  describeFeedFilter(filter, t).join(FEED_FILTER_SEPARATOR);
