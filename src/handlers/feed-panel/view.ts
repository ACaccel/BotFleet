import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type InteractionEditReplyOptions,
} from 'discord.js';
import type { BoundTranslate } from '../../core/i18n';
import { feedFilterCapabilities } from '../../infra/social-feed/filter-capabilities';
import { FEED_MEDIA_FILTERS } from '../../persistence/schemas/feed-subscription.schema';
import { formatFeedFilter } from '../feed-filter-labels';
import { feedPlatformDisplayName } from '../feed-platform-name';
import { formatFeedTarget } from '../feed-target-label';
import { feedPanelId, type FeedPanelSession } from './session';

export const FEED_EDITOR_PAGE_SIZE = 25;
const safeLabel = (value: string, maximum = 100): string =>
  value.replace(/[`\r\n]/g, ' ').slice(0, maximum);

const button = (
  session: FeedPanelSession,
  action: string,
  label: string,
  style = ButtonStyle.Secondary,
) =>
  new ButtonBuilder().setCustomId(feedPanelId(session.id, action)).setLabel(label).setStyle(style);

export const renderFeedPanel = (
  session: FeedPanelSession,
  t: BoundTranslate,
): InteractionEditReplyOptions => {
  const draft = session.draft;
  if (draft.kind === 'list') {
    const pages = Math.max(1, Math.ceil(draft.targets.length / FEED_EDITOR_PAGE_SIZE));
    const page = Math.min(Math.max(draft.page, 0), pages - 1);
    const targets = draft.targets.slice(
      page * FEED_EDITOR_PAGE_SIZE,
      (page + 1) * FEED_EDITOR_PAGE_SIZE,
    );
    const select = new StringSelectMenuBuilder()
      .setCustomId(feedPanelId(session.id, 'target'))
      .setPlaceholder(t('replies:feed.panel.choose_target'))
      .addOptions(
        targets.map((target) => ({
          label: safeLabel(
            `${feedPlatformDisplayName(target.platform)} ${formatFeedTarget(target.platform, target.account, t)}`,
          ),
          description: safeLabel(
            t('replies:feed.panel.destination', { channel: target.channelId }),
          ),
          value: target.id,
        })),
      );
    return {
      content: t('replies:feed.panel.list_title', { page: page + 1, pages }),
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          button(session, 'previous', t('replies:feed.panel.previous')).setDisabled(page === 0),
          button(session, 'next', t('replies:feed.panel.next')).setDisabled(page === pages - 1),
          button(session, 'cancel', t('replies:feed.panel.close')),
        ),
      ],
      allowedMentions: { parse: [] },
    };
  }
  const capabilities = feedFilterCapabilities(draft.platformId);
  const components: NonNullable<InteractionEditReplyOptions['components']>[number][] = [];
  if (capabilities.media) {
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(feedPanelId(session.id, 'media'))
          .setPlaceholder(t('replies:feed.panel.media'))
          .addOptions(
            FEED_MEDIA_FILTERS.map((value) => ({
              label: t(`replies:feed.filter_media.${value}`),
              value,
              default: draft.filter.media === value,
            })),
          ),
      ),
    );
  }
  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      button(session, 'keyword', t('replies:feed.panel.keyword')),
      button(session, 'save', t('replies:feed.panel.save'), ButtonStyle.Success),
      button(session, 'cancel', t('replies:feed.panel.cancel')),
    ),
  );
  return {
    content: [
      t('replies:feed.panel.title', {
        platform: feedPlatformDisplayName(draft.platformId),
        channel: `<#${draft.channelId}>`,
      }),
      draft.accounts
        .map((account) => `\`${safeLabel(formatFeedTarget(draft.platformId, account, t), 100)}\``)
        .join(', ')
        .slice(0, 1000),
      formatFeedFilter(draft.filter, t, draft.platformId),
      t('replies:feed.panel.save_notice'),
      ...(draft.accounts.length > 1 ? [t('replies:feed.panel.batch_notice')] : []),
    ].join('\n'),
    components,
    allowedMentions: { parse: [] },
  };
};

export { buildFeedKeywordModal } from './keyword-modal';
