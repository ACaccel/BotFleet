/**
 * Renders the guild's feed subscriptions into Discord-sendable pages.
 *
 * Pure: it takes the documents and a translate function, so every
 * grouping and pagination rule is testable without an interaction, a
 * database, or a live catalog. The filter labels come from the module
 * `/feed subscribe` also reports through.
 */
import type { BoundTranslate } from '../../../core/i18n';
import { paginateLines } from '../../../infra/discord/paginate';
import type { FeedSubscriptionDoc } from '../../../persistence/schemas/feed-subscription.schema';
import { FEED_FILTER_SEPARATOR, describeFeedFilter } from '../../feed-filter-labels';

/**
 * One subscription's line. The forwarding time is a Discord relative
 * timestamp rather than a formatted date, so each reader sees it in
 * their own locale and timezone without the bot knowing either.
 */
const formatSubscription = (doc: FeedSubscriptionDoc, t: BoundTranslate): string => {
  const forwarded =
    doc.last_seen_timestamp === undefined
      ? t('replies:feed.never_forwarded')
      : `<t:${String(doc.last_seen_timestamp)}:R>`;
  const annotations = [...describeFeedFilter(doc.filter, t), forwarded];
  return `- \`${doc.platform} @${doc.account}\` — ${annotations.join(FEED_FILTER_SEPARATOR)}`;
};

/**
 * Group by destination channel, keeping first-seen order.
 *
 * The repository sorts by platform and account, which interleaves
 * channels; grouping here rather than re-sorting keeps that ordering
 * inside each group.
 */
const groupByChannel = (
  docs: readonly FeedSubscriptionDoc[],
): ReadonlyMap<string, readonly FeedSubscriptionDoc[]> => {
  const groups = new Map<string, FeedSubscriptionDoc[]>();
  for (const doc of docs) {
    const bucket = groups.get(doc.channel_id);
    if (bucket === undefined) groups.set(doc.channel_id, [doc]);
    else bucket.push(doc);
  }
  return groups;
};

/**
 * The pages describing `docs`, grouped by channel under a count header.
 * Returns an empty array for an empty list; the caller sends its own
 * "nothing subscribed" copy in that case.
 */
export const formatSubscriptionPages = (
  docs: readonly FeedSubscriptionDoc[],
  t: BoundTranslate,
): readonly string[] => {
  if (docs.length === 0) return [];
  const lines: string[] = [t('replies:feed.list_header', { total: docs.length })];
  for (const [channelId, group] of groupByChannel(docs)) {
    lines.push(`<#${channelId}>`);
    for (const doc of group) lines.push(formatSubscription(doc, t));
  }
  return paginateLines(lines);
};
