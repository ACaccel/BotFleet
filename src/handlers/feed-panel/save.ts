import type { BaseBot } from '@bot';
import { bindTranslator } from '../../core/i18n';
import { logError, logSystem, ops } from '../../core/logger';
import { sendPagedEphemeralReply } from '../../infra/discord/send-paged-reply';
import type { FeedSubscriptionDoc } from '../../persistence/schemas/feed-subscription.schema';
import { requireGuildRepos } from '../require-guild-repos';
import { platformNotConfiguredError } from './platform-not-configured';
import { writableFeedChannel, type PanelInteraction } from './context';
import { FEED_BATCH_BUDGET_MS } from './batch-policy';
import { formatOutcomePages, formatOutcomesForLog } from './format-outcomes';
import { feedPanelSessions, FeedPanelError, type FeedPanelSession } from './session';
import { subscribeAccounts } from './subscribe-accounts';

export const saveFeedPanel = async (
  interaction: PanelInteraction,
  bot: BaseBot,
  session: FeedPanelSession,
): Promise<void> => {
  const draft = session.draft;
  if (draft.kind !== 'filter') throw new FeedPanelError('invalid');
  const repos = await requireGuildRepos(bot, interaction);
  if (!repos) return;
  const gate = writableFeedChannel(interaction, bot, draft.channelId);
  const platform = bot.feedPlatformRegistry?.get(draft.platformId);
  if (!platform) throw platformNotConfiguredError(draft.platformId);
  let existingId: FeedSubscriptionDoc['_id'] | undefined;
  if (draft.subscriptionId) {
    const found = await repos.feedSubscription.find(
      draft.platformId,
      draft.accounts[0] ?? '',
      draft.channelId,
    );
    if (!found.ok) throw found.error;
    if (found.value?._id.toString() !== draft.subscriptionId) throw new FeedPanelError('expired');
    existingId = found.value._id;
  }
  session.saving = true;
  try {
    await interaction.editReply({ components: [] });
    const outcomes = await subscribeAccounts({
      platform,
      repo: repos.feedSubscription,
      accounts: draft.accounts,
      ...(existingId === undefined ? {} : { existingId }),
      channelId: draft.channelId,
      createdBy: interaction.user.id,
      filter: draft.filter,
      deadlineMs: interaction.createdTimestamp + FEED_BATCH_BUDGET_MS,
      logFailure: (cause) => logError(bot.logger, interaction.guildId, cause),
    });
    logSystem(
      bot.logger,
      ops.feed.subscriptionsProcessed(
        draft.channelId,
        outcomes.length,
        formatOutcomesForLog(outcomes, draft.platformId),
      ),
    );
    feedPanelSessions(bot).close(session.id);
    const t = bindTranslator(bot.translator);
    await sendPagedEphemeralReply(
      interaction,
      formatOutcomePages(
        outcomes,
        {
          platform: platform.displayName,
          platformId: platform.id,
          channel: gate.mention,
          filter: draft.filter,
        },
        t,
      ),
      {
        logger: bot.logger,
        partialNotice: (failed) => t('replies:common.pages_failed', { count: failed }),
      },
    );
  } finally {
    session.saving = false;
  }
};
