/**
 * Renders what `/feed unsubscribe` deleted, bounded so the confirmation
 * always fits in one Discord message. Shared with the button that
 * confirms clearing a whole channel, which reports the same list.
 *
 * The bound is not cosmetic. `deleteMany` has already committed by the
 * time this runs, so a reply that overflowed the 2000-character limit
 * would be rejected, fall into the handler's error boundary, and tell
 * the member the operation *failed* — after it had irreversibly
 * succeeded. Truncating with a count of the remainder keeps the message
 * deliverable and honest; the full list goes to the operator log.
 */
import type { BoundTranslate } from '../core/i18n';
import type { FeedSubscriptionDoc } from '../persistence/schemas/feed-subscription.schema';
import { formatFeedTarget } from './feed-target-label';

/**
 * How many entries the confirmation lists. A line is at most a platform
 * id plus a handle in backticks, so 20 lines sit far inside the message
 * limit even with the header and the remainder notice.
 */
export const MAX_LISTED_REMOVALS = 20;

/** The platform and copyable target that were actually removed. */
const subscriptionKey = (doc: FeedSubscriptionDoc, t?: BoundTranslate): string =>
  `${doc.platform} ${formatFeedTarget(doc.platform, doc.account, t)}`;

/** Plain, unbounded rendering for the operator log. */
export const formatRemovedForLog = (docs: readonly FeedSubscriptionDoc[]): string =>
  docs.map((doc) => `${subscriptionKey(doc)} -> ${doc.channel_id}`).join('; ');

/**
 * The list body of the confirmation: one backticked entry per line, cut
 * at {@link MAX_LISTED_REMOVALS} with a translated tail naming how many
 * were left out.
 */
export const formatRemovedForReply = (
  docs: readonly FeedSubscriptionDoc[],
  t: BoundTranslate,
): string => {
  const shown = docs.slice(0, MAX_LISTED_REMOVALS);
  const lines = shown.map((doc) => `\`${subscriptionKey(doc, t)}\``);
  const hidden = docs.length - shown.length;
  if (hidden > 0) lines.push(t('replies:feed.unsubscribed_more', { count: hidden }));
  return lines.join('\n');
};
