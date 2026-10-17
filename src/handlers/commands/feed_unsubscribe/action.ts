/**
 * `/feed unsubscribe` — stop forwarding social posts into a channel.
 *
 * The channel always scopes deletion; platform and target only narrow
 * it. `gateFeedChannel` bounds deletion and suggestions by visibility.
 *
 * Whole-channel deletion counts and asks first; a narrowed scope applies
 * immediately. Confirmation after deletion could not undo the removal.
 * Stored canonical targets remain removable after their platform has
 * been switched off in config. Resolving a floor URL may need upstream.
 */
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command, type CommandSuggestions } from '@cmd';

import { bindTranslator, type TranslationKey, type TranslationParams } from '../../../core/i18n';
import { logSystem, ops } from '../../../core/logger';
import { getOptionalString } from '../../../infra/discord/options';
import { replyForError } from '../../../infra/discord/reply-for-error';
import {
  SUPPORTED_FEED_PLATFORMS,
  feedAccountRefusal,
  parseFeedAccounts,
} from '../../../infra/social-feed';
import { gateFeedChannel } from '../../feed-channel-gate';
import { requireGuildRepos } from '../../require-guild-repos';
import { buildClearConfirmation } from './confirm-prompt';
import { formatRemovedForLog, formatRemovedForReply } from '../../feed-removed-list';
import { resolveUnsubscribeAccounts } from './resolve-account';
import { suggestUnsubscribeAccounts } from './suggest-accounts';

const platformChoices = SUPPORTED_FEED_PLATFORMS.map((id) => ({ value: id }));

export default class feed_unsubscribe extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'feed_unsubscribe',
      category: 'community',
      // Declaration order keeps narrowing options before the channel.
      options: {
        string: [
          { name: 'platform', required: false, choices: platformChoices },
          { name: 'target', required: false, autocomplete: true },
        ],
        channel: [{ name: 'channel', required: false }],
      },
    });
  }

  public override autocomplete(
    interaction: AutocompleteInteraction,
    bot: BaseBot,
  ): Promise<CommandSuggestions> {
    return suggestUnsubscribeAccounts(interaction, bot);
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    // Falls back to the key, never to '', which Discord rejects.
    const t = bindTranslator(bot.translator);
    const refuse = async (key: TranslationKey, params?: TranslationParams): Promise<void> => {
      await interaction.editReply({ content: t(key, params) });
    };
    try {
      const guild = interaction.guild;
      const repos = await requireGuildRepos(bot, interaction);
      // Already replied on null; the `guild` half restates that for tsc.
      if (repos === null || guild === null) return;

      const selected = interaction.options.getChannel('channel');
      const channelId = selected?.id ?? interaction.channelId;
      const gate = gateFeedChannel(guild, channelId, interaction.user.id);
      if (gate.kind === 'refused') return refuse(gate.key, gate.params);
      const { channel, mention } = gate;

      // The option names as many accounts as the member cares to list;
      // an unusable list is refused before anything is deleted.
      const raw = getOptionalString(interaction, 'target');
      const parsed = raw === undefined ? undefined : parseFeedAccounts(raw);
      if (parsed !== undefined && parsed.kind !== 'accounts') {
        return refuse(...feedAccountRefusal(parsed));
      }

      const platform = getOptionalString(interaction, 'platform');
      const accounts = await resolveUnsubscribeAccounts(
        platform === undefined ? undefined : bot.feedPlatformRegistry?.get(platform),
        parsed?.accounts,
        platform,
      );
      // An invalid handle is reported as such rather than as an empty
      // deletion; `replyForError` renders its `errors:feed.*` copy.
      if (!accounts.ok) throw accounts.error;

      if (platform === undefined && accounts.value === undefined) {
        // Whole channel: count first, delete only once the member has
        // seen the number and said yes. The confirm button re-reads
        // before deleting, and reports what it actually removed.
        const existing = await repos.feedSubscription.listByChannel(channel.id);
        if (!existing.ok) throw existing.error;
        const count = existing.value.length;
        if (count === 0) return refuse('replies:feed.unsubscribed_none', { channel: mention });
        const invokerId = interaction.user.id;
        await interaction.editReply(
          buildClearConfirmation({ channelId: channel.id, invokerId, count, mention }, t),
        );
        return;
      }

      const deleted = await repos.feedSubscription.deleteWhere({
        channelId: channel.id,
        platform,
        accounts: accounts.value,
      });
      if (!deleted.ok) throw deleted.error;
      const removed = deleted.value;

      // Only a narrowed scope reaches here, so the narrowing is the
      // likeliest reason nothing matched.
      if (removed.length === 0) {
        return refuse('replies:feed.unsubscribed_none_hint', { channel: mention });
      }

      // Logged before the reply: the deletion has already committed, and
      // the confirmation is both bounded and losable.
      logSystem(
        bot.logger,
        ops.feed.subscriptionsRemoved(channel.id, removed.length, formatRemovedForLog(removed)),
      );
      await interaction.editReply({
        content: t('replies:feed.unsubscribed', {
          count: removed.length,
          list: formatRemovedForReply(removed, t),
        }),
      });
    } catch (err) {
      await replyForError(interaction, bot, err, 'replies:feed.failed', interaction.guildId);
    }
  }
}
