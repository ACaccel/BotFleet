/**
 * The customId contract between `/feed unsubscribe`'s confirmation
 * prompt and the two buttons that answer it.
 *
 * The dispatcher selects a handler by the customId's leading segment
 * (see `createCustomIdDispatcher`), so the ids below are also the
 * handler directory names — a rename that touched only one of the two
 * would leave a live button nobody answers. Encoding and decoding live
 * together for the same reason: the command writes the id and the
 * buttons read it back, and a format the two disagreed about would
 * surface as a silently dead button rather than as an error.
 *
 * A button is a public component, so the payload carries no authority:
 * it names the channel to clear and the member who asked, and the
 * confirm handler re-derives every permission from scratch.
 */

/** Handler name for the Danger button that performs the clear. */
export const FEED_CLEAR_CONFIRM_ID = 'feed_clear_confirm';

/** Handler name for the Secondary button that abandons it. */
export const FEED_CLEAR_CANCEL_ID = 'feed_clear_cancel';

/** What the confirmation prompt is about, as carried by the customId. */
export interface FeedClearScope {
  readonly channelId: string;
  /** The member who ran `/feed unsubscribe`; the only one who may answer. */
  readonly invokerId: string;
}

/**
 * `<handler>|<channelId>|<invokerId>` — three snowflake-sized segments,
 * far inside Discord's 100-character customId limit.
 */
export const encodeFeedClearCustomId = (
  handler: typeof FEED_CLEAR_CONFIRM_ID | typeof FEED_CLEAR_CANCEL_ID,
  scope: FeedClearScope,
): string => `${handler}|${scope.channelId}|${scope.invokerId}`;

/**
 * Read a scope back, or `undefined` when the id is not one this build
 * writes. A malformed id is not an error to report: it belongs to an
 * older deployment or another bot, and the caller refuses rather than
 * guessing at a channel to clear.
 */
export const decodeFeedClearCustomId = (customId: string): FeedClearScope | undefined => {
  const parts = customId.split('|');
  // Exactly three, so decoding stays the inverse of encoding rather
  // than a prefix match that would accept another handler's payload.
  if (parts.length !== 3) return undefined;
  const [, channelId, invokerId] = parts;
  if (channelId === undefined || invokerId === undefined) return undefined;
  if (channelId.length === 0 || invokerId.length === 0) return undefined;
  return { channelId, invokerId };
};
