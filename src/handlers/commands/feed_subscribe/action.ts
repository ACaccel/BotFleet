/**
 * `/feed subscribe` forwards new content from targets into one channel.
 * Gate the channel once, then subscribe each target independently.
 *
 * Any member may subscribe within channels they can see. Check bot
 * permissions last so an inaccessible channel reveals no bot state.
 */
import type { ChatInputCommandInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { bindTranslator } from '../../../core/i18n';
import { logError, logSystem, ops } from '../../../core/logger';
import { getOptionalString, getRequiredString } from '../../../infra/discord/options';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { sendPagedEphemeralReply } from '../../../infra/discord/send-paged-reply';
import {
  SUPPORTED_FEED_PLATFORMS,
  feedAccountRefusal,
  parseFeedAccounts,
} from '../../../infra/social-feed';
import { FEED_MEDIA_FILTERS } from '../../../persistence/schemas/feed-subscription.schema';
import { gateFeedChannel } from '../../feed-channel-gate';
import { requireGuildRepos } from '../../require-guild-repos';
import { FEED_BATCH_BUDGET_MS } from './batch-policy';
import { buildSubscriptionFilter } from './build-filter';
import { formatOutcomePages, formatOutcomesForLog } from './format-outcomes';
import { PERMISSION_LABEL_KEYS, missingFeedPermissions } from './permission-requirements';
import { platformNotConfiguredError } from './platform-not-configured';
import { subscribeAccounts } from './subscribe-accounts';

const platformChoices = SUPPORTED_FEED_PLATFORMS.map((id) => ({ value: id }));
const mediaChoices = FEED_MEDIA_FILTERS.map((value) => ({ value }));

export default class feed_subscribe extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'feed_subscribe',
      category: 'community',
      // Choice lists derive from the shipped constants; widening
      // either never edits this handler.
      options: {
        string: [
          { name: 'platform', required: true, choices: platformChoices },
          { name: 'target', required: true },
          { name: 'media', required: false, choices: mediaChoices },
          { name: 'keyword', required: false },
        ],
        channel: [{ name: 'channel', required: false }],
      },
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    // Falls back to the key, never to '', which Discord rejects.
    const t = bindTranslator(bot.translator);
    const refuse = async (key: string, params?: Record<string, string | number>): Promise<void> => {
      await interaction.editReply({ content: t(key, params) });
    };
    try {
      const raw = getOptionalString(interaction, 'target');
      if (raw === undefined) return refuse('replies:feed.no_accounts');
      const platformId = getRequiredString(interaction, 'platform');
      const platform = bot.feedPlatformRegistry?.get(platformId);
      if (platform === undefined) throw platformNotConfiguredError(platformId);

      const parsed = parseFeedAccounts(raw);
      if (parsed.kind !== 'accounts') return refuse(...feedAccountRefusal(parsed));

      const guild = interaction.guild;
      const repos = await requireGuildRepos(bot, interaction);
      // Already replied on null; the `guild` half restates that for tsc.
      if (repos === null || guild === null) return;

      // The invoker's reach is decided by the same gate every `/feed`
      // surface uses, before anything about the bot's side is revealed.
      const selected = interaction.options.getChannel('channel');
      const gated = gateFeedChannel(
        guild,
        selected?.id ?? interaction.channelId,
        interaction.user.id,
      );
      if (gated.kind === 'refused') return refuse(gated.key, gated.params);
      const { channel, mention } = gated;
      // `isSendable` is the exact predicate the poller demands of a
      // destination, so whatever passes here is what it can deliver to.
      if (!channel.isSendable()) return refuse('replies:feed.channel_not_supported');

      // A thread inherits its overwrites from the parent, and asking a
      // thread whose parent is uncached answers null — "unknown", never
      // "denied"; the bot member is resolved for the same reason.
      const parent = channel.isThread() ? channel.parent : channel;
      const me = guild.members.me;
      const botPerms = parent === null || me === null ? null : parent.permissionsFor(me);
      if (botPerms === null) {
        return refuse('replies:feed.permissions_unknown', { channel: mention });
      }

      const missing = missingFeedPermissions((bit) => botPerms.has(bit), channel.isThread());
      if (missing.length > 0) {
        logSystem(bot.logger, ops.feed.missingBotPermissions(channel.id, missing.join(', ')));
        return refuse('replies:feed.missing_bot_permissions', {
          channel: mention,
          permissions: missing
            .map((name) => t(`replies:feed.permission.${PERMISSION_LABEL_KEYS[name]}`))
            .join(t('replies:feed.permission_separator')),
        });
      }

      const filter = buildSubscriptionFilter(
        getOptionalString(interaction, 'media') ?? platform.defaultMediaFilter,
        getOptionalString(interaction, 'keyword'),
      );
      const outcomes = await subscribeAccounts({
        platform,
        repo: repos.feedSubscription,
        accounts: parsed.accounts,
        channelId: channel.id,
        createdBy: interaction.user.id,
        filter,
        deadlineMs: interaction.createdTimestamp + FEED_BATCH_BUDGET_MS,
        logFailure: (cause) => logError(bot.logger, interaction.guildId, cause),
      });
      // Each failure was logged where it was absorbed; this line is the
      // durable record of the batch as a whole.
      const summary = formatOutcomesForLog(outcomes, platformId);
      logSystem(bot.logger, ops.feed.subscriptionsProcessed(channel.id, outcomes.length, summary));

      const report = { platform: platform.displayName, platformId, channel: mention, filter };
      await sendPagedEphemeralReply(interaction, formatOutcomePages(outcomes, report, t), {
        logger: bot.logger,
        partialNotice: (failed) => t('replies:common.pages_failed', { count: failed }),
      });
    } catch (err) {
      await replyForError(interaction, bot, err, 'replies:feed.failed', interaction.guildId);
    }
  }
}
