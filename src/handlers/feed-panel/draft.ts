import type { BaseBot } from '@bot';
import { feedFilterCapabilities } from '../../infra/social-feed/filter-capabilities';
import { isFeedMediaFilter } from '../../persistence/schemas/feed-subscription.schema';
import { requireGuildRepos } from '../require-guild-repos';
import { platformNotConfiguredError } from './platform-not-configured';
import { buildSubscriptionFilter } from './build-filter';
import { FeedPanelNotice, writableFeedChannel, type PanelInteraction } from './context';
import { FeedPanelError, type FeedPanelSession } from './session';
import { FEED_EDITOR_PAGE_SIZE } from './view';

export const updateFeedDraft = async (
  interaction: PanelInteraction,
  bot: BaseBot,
  session: FeedPanelSession,
  parsed: { readonly action: string; readonly detail: string },
): Promise<boolean> => {
  const draft = session.draft;
  if (draft.kind === 'list') {
    if (interaction.isButton() && (parsed.action === 'previous' || parsed.action === 'next')) {
      const pages = Math.ceil(draft.targets.length / FEED_EDITOR_PAGE_SIZE);
      draft.page = Math.max(
        0,
        Math.min(pages - 1, draft.page + (parsed.action === 'next' ? 1 : -1)),
      );
    } else if (interaction.isStringSelectMenu() && parsed.action === 'target') {
      const selected = draft.targets.find((target) => target.id === interaction.values[0]);
      if (interaction.values.length !== 1 || !selected) throw new FeedPanelError('invalid');
      writableFeedChannel(interaction, bot, selected.channelId);
      if (!bot.feedPlatformRegistry?.get(selected.platform))
        throw platformNotConfiguredError(selected.platform);
      const repos = await requireGuildRepos(bot, interaction);
      if (!repos) return false;
      const found = await repos.feedSubscription.find(
        selected.platform,
        selected.account,
        selected.channelId,
      );
      if (!found.ok) throw found.error;
      if (found.value?._id.toString() !== selected.id) throw new FeedPanelError('expired');
      session.draft = {
        kind: 'filter',
        platformId: selected.platform,
        accounts: [selected.account],
        channelId: selected.channelId,
        subscriptionId: selected.id,
        filter: { ...found.value.filter },
      };
    } else throw new FeedPanelError('invalid');
  } else {
    writableFeedChannel(interaction, bot, draft.channelId);
    const capabilities = feedFilterCapabilities(draft.platformId);
    if (interaction.isStringSelectMenu() && interaction.values.length === 1) {
      const value = interaction.values[0];
      if (parsed.action === 'media' && capabilities.media && isFeedMediaFilter(value)) {
        draft.filter = { ...draft.filter, media: value };
      } else throw new FeedPanelError('invalid');
    } else if (interaction.isModalSubmit() && parsed.action === 'keyword_submit') {
      if (!session.modalNonce || parsed.detail !== session.modalNonce)
        throw new FeedPanelError('expired');
      session.modalNonce = undefined;
      const built = buildSubscriptionFilter(
        draft.filter.media,
        interaction.fields.getTextInputValue('keyword'),
      );
      if (built.kind === 'refused') throw new FeedPanelNotice(...built.refusal);
      const { keyword: _previous, ...rest } = draft.filter;
      draft.filter = { ...rest, ...built.filter };
    } else throw new FeedPanelError('invalid');
  }
  return true;
};
