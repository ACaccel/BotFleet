import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import type { BoundTranslate } from '../../core/i18n';
import { feedPanelId, type FeedPanelSession } from './session';

export const buildFeedKeywordModal = (
  session: FeedPanelSession,
  nonce: string,
  t: BoundTranslate,
): ModalBuilder =>
  new ModalBuilder()
    .setCustomId(feedPanelId(session.id, 'keyword_submit', nonce))
    .setTitle(t('replies:feed.panel.keyword_title'))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('keyword')
          .setLabel(t('replies:feed.panel.keyword_label'))
          .setPlaceholder(t('replies:feed.panel.keyword_hint'))
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(false)
          .setValue(session.draft.kind === 'filter' ? (session.draft.filter.keyword ?? '') : ''),
      ),
    );
