import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { bindTranslator } from '../../core/i18n';
import type { FeedSubscriptionFilterInput } from '../../persistence/repositories';
import type { FeedSubscriptionDoc } from '../../persistence/schemas/feed-subscription.schema';
import { requireGuildRepos } from '../require-guild-repos';
import { platformNotConfiguredError } from './platform-not-configured';
import { actorFor, writableFeedChannel } from './context';
import { feedPanelSessions } from './session';
import { renderFeedPanel } from './view';

export const openFeedSubscriptionPanel = async (
  interaction: ChatInputCommandInteraction,
  bot: BaseBot,
  platformId: string,
  accounts: readonly string[],
  channelId: string,
): Promise<void> => {
  const platform = bot.feedPlatformRegistry?.get(platformId);
  if (!platform) throw platformNotConfiguredError(platformId);
  const repos = await requireGuildRepos(bot, interaction);
  if (!repos) return;
  writableFeedChannel(interaction, bot, channelId);
  let filter: FeedSubscriptionFilterInput = {
    media: platform.defaultMediaFilter ?? 'media_only',
  };
  let targets = accounts;
  let subscriptionId: string | undefined;
  if (accounts.length === 1) {
    const normalized = await platform.normalizeAccount(accounts[0] ?? '');
    if (!normalized.ok) throw normalized.error;
    targets = [normalized.value];
    const found = await repos.feedSubscription.find(platformId, normalized.value, channelId);
    if (!found.ok) throw found.error;
    if (found.value) {
      filter = { ...found.value.filter };
      subscriptionId = found.value._id.toString();
    }
  }
  const sessions = feedPanelSessions(bot);
  const session = sessions.open(actorFor(interaction), {
    ...(subscriptionId === undefined ? {} : { subscriptionId }),
    kind: 'filter',
    platformId,
    accounts: targets,
    channelId,
    filter,
  });
  try {
    const message = await interaction.editReply(
      renderFeedPanel(session, bindTranslator(bot.translator)),
    );
    session.messageId = message.id;
  } catch (error) {
    sessions.close(session.id);
    throw error;
  }
};

/** Attach the editor to the first list page without changing its text or overflow. */
export const attachFeedListEditor = async (
  interaction: ChatInputCommandInteraction,
  bot: BaseBot,
  docs: readonly FeedSubscriptionDoc[],
): Promise<void> => {
  const sessions = feedPanelSessions(bot);
  const session = sessions.open(actorFor(interaction), {
    kind: 'list',
    page: 0,
    targets: docs.map((doc) => ({
      id: doc._id.toString(),
      platform: doc.platform,
      account: doc.account,
      channelId: doc.channel_id,
    })),
  });
  try {
    const panel = renderFeedPanel(session, bindTranslator(bot.translator));
    const message = await interaction.editReply({
      components: panel.components,
      allowedMentions: { parse: [] },
    });
    session.messageId = message.id;
  } catch (error) {
    sessions.close(session.id);
    throw error;
  }
};
