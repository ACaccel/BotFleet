/**
 * The prompt `/feed unsubscribe` shows before clearing a whole channel.
 *
 * Split out of the command because it is the one reply that is not an
 * answer but a question: it has to name the channel and the exact
 * number at stake, and it has to carry the two buttons that decide.
 *
 * The copy is deliberately blunt about being irreversible. The
 * ephemeral confirmation that used to follow the deletion told a member
 * what had already happened; this one is the last point at which they
 * can still say no.
 */
import type { InteractionEditReplyOptions } from 'discord.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

import type { BoundTranslate } from '../../../core/i18n';
import {
  FEED_CLEAR_CANCEL_ID,
  FEED_CLEAR_CONFIRM_ID,
  encodeFeedClearCustomId,
  type FeedClearScope,
} from '../../feed-clear-custom-id';

/** What the member is being asked to confirm. */
interface ClearConfirmation extends FeedClearScope {
  /** Subscriptions the channel held when the count was taken. */
  readonly count: number;
  /** `<#id>` for the target channel. */
  readonly mention: string;
}

/**
 * Danger on the destructive button and Secondary on the way out, so the
 * colour carries the same warning the copy does.
 */
const buildRow = (scope: FeedClearScope, t: BoundTranslate): ActionRowBuilder<ButtonBuilder> =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeFeedClearCustomId(FEED_CLEAR_CONFIRM_ID, scope))
      .setLabel(t('replies:feed.clear_confirm_label'))
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(encodeFeedClearCustomId(FEED_CLEAR_CANCEL_ID, scope))
      .setLabel(t('replies:feed.clear_cancel_label'))
      .setStyle(ButtonStyle.Secondary),
  );

/** The full `editReply` payload for the confirmation prompt. */
export const buildClearConfirmation = (
  confirmation: ClearConfirmation,
  t: BoundTranslate,
): InteractionEditReplyOptions => ({
  content: t('replies:feed.clear_confirm', {
    channel: confirmation.mention,
    count: confirmation.count,
  }),
  components: [
    buildRow({ channelId: confirmation.channelId, invokerId: confirmation.invokerId }, t),
  ],
});
