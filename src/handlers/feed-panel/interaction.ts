import { randomBytes } from 'node:crypto';
import type { BaseBot } from '@bot';
import { bindTranslator } from '../../core/i18n';
import {
  actorFor,
  reportFeedPanelError,
  writableFeedChannel,
  type PanelInteraction,
} from './context';
import { feedPanelSessions, FeedPanelError, parseFeedPanelId } from './session';
import { saveFeedPanel } from './save';
import { updateFeedDraft } from './draft';
import { buildFeedKeywordModal, renderFeedPanel } from './view';

export { openFeedSubscriptionPanel, attachFeedListEditor } from './open';
export { reportFeedPanelError } from './context';

export const handleFeedPanelInteraction = async (
  interaction: PanelInteraction,
  bot: BaseBot,
): Promise<void> => {
  try {
    const parsed = parseFeedPanelId(interaction.customId);
    if (!parsed || (parsed.action !== 'keyword_submit' && parsed.detail !== ''))
      throw new FeedPanelError('invalid');
    const sessions = feedPanelSessions(bot);
    const session = sessions.get(parsed.sessionId, actorFor(interaction));
    const t = bindTranslator(bot.translator);
    if (interaction.isButton() && parsed.action === 'keyword') {
      if (session.draft.kind !== 'filter') throw new FeedPanelError('invalid');
      writableFeedChannel(interaction, bot, session.draft.channelId);
      const nonce = randomBytes(8).toString('base64url');
      session.modalNonce = nonce;
      await interaction.showModal(buildFeedKeywordModal(session, nonce, t));
      return;
    }
    if (interaction.isButton() && parsed.action === 'save') {
      session.saving = true;
      try {
        await interaction.deferUpdate();
        await saveFeedPanel(interaction, bot, session);
      } finally {
        session.saving = false;
      }
      return;
    }
    await interaction.deferUpdate();
    if (interaction.isButton() && parsed.action === 'cancel') {
      sessions.close(session.id);
      await interaction.editReply({ content: t('replies:feed.panel.cancelled'), components: [] });
      return;
    }
    if (!(await updateFeedDraft(interaction, bot, session, parsed))) return;
    await interaction.editReply(renderFeedPanel(session, t));
  } catch (error) {
    await reportFeedPanelError(interaction, bot, error);
  }
};
