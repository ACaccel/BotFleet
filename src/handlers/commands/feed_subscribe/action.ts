/** `/feed subscribe` opens a platform-specific draft; saving performs the write. */
import type { ChatInputCommandInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';
import { bindTranslator } from '../../../core/i18n';
import { getOptionalString, getRequiredString } from '../../../infra/discord/options';
import {
  SUPPORTED_FEED_PLATFORMS,
  feedAccountRefusal,
  parseFeedAccounts,
} from '../../../infra/social-feed';
import { openFeedSubscriptionPanel, reportFeedPanelError } from '../../feed-panel/interaction';

export default class feed_subscribe extends Command {
  public constructor() {
    super();
    this.setConfig({
      name: 'feed_subscribe',
      category: 'community',
      options: {
        string: [
          {
            name: 'platform',
            required: true,
            choices: SUPPORTED_FEED_PLATFORMS.map((value) => ({ value })),
          },
          { name: 'target', required: true },
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
    const t = bindTranslator(bot.translator);
    try {
      const raw = getOptionalString(interaction, 'target');
      if (raw === undefined) {
        await interaction.editReply({ content: t('replies:feed.no_accounts') });
        return;
      }
      const platformId = getRequiredString(interaction, 'platform');
      const parsed = parseFeedAccounts(raw, platformId);
      if (parsed.kind !== 'accounts') {
        const [key, params] = feedAccountRefusal(parsed);
        await interaction.editReply({ content: t(key, params) });
        return;
      }
      await openFeedSubscriptionPanel(
        interaction,
        bot,
        platformId,
        parsed.accounts,
        interaction.options.getChannel('channel')?.id ?? interaction.channelId,
      );
    } catch (error) {
      await reportFeedPanelError(interaction, bot, error);
    }
  }
}
