import {
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { BaseBot } from '@bot';
import { bindTranslator, type TranslationParams } from '../../core/i18n';
import { logSystem, ops } from '../../core/logger';
import { replyForError } from '../../infra/discord/reply-for-error';
import { gateFeedChannel } from '../feed-channel-gate';
import { PERMISSION_LABEL_KEYS, missingFeedPermissions } from './permission-requirements';
import { FeedPanelError, type FeedPanelActor } from './session';

export type PanelInteraction =
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ModalSubmitInteraction;
export type FeedInteraction = PanelInteraction | ChatInputCommandInteraction;

export class FeedPanelNotice extends Error {
  public constructor(
    public readonly key: string,
    public readonly params?: TranslationParams,
  ) {
    super(key);
  }
}

export const actorFor = (interaction: FeedInteraction): FeedPanelActor => {
  if (!interaction.guildId) throw new FeedPanelNotice('errors:command.guild_only');
  const messageId = 'message' in interaction ? interaction.message?.id : undefined;
  return {
    applicationId: interaction.applicationId,
    guildId: interaction.guildId,
    userId: interaction.user.id,
    ...(messageId === undefined ? {} : { messageId }),
  };
};

/** Rechecked on save because a draft can outlive channel permission changes. */
export const writableFeedChannel = (
  interaction: FeedInteraction,
  bot: BaseBot,
  channelId: string,
): Extract<ReturnType<typeof gateFeedChannel>, { kind: 'visible' }> => {
  if (!interaction.guild) throw new FeedPanelNotice('errors:command.guild_only');
  const gate = gateFeedChannel(interaction.guild, channelId, interaction.user.id);
  if (gate.kind === 'refused') throw new FeedPanelNotice(gate.key, gate.params);
  const { channel, mention } = gate;
  if (!channel.isSendable()) throw new FeedPanelNotice('replies:feed.channel_not_supported');
  const parent = channel.isThread() ? channel.parent : channel;
  const me = interaction.guild.members.me;
  const permissions = parent === null || me === null ? null : parent.permissionsFor(me);
  if (permissions === null)
    throw new FeedPanelNotice('replies:feed.permissions_unknown', { channel: mention });
  const missing = missingFeedPermissions((bit) => permissions.has(bit), channel.isThread());
  if (missing.length > 0) {
    const t = bindTranslator(bot.translator);
    logSystem(bot.logger, ops.feed.missingBotPermissions(channel.id, missing.join(', ')));
    throw new FeedPanelNotice('replies:feed.missing_bot_permissions', {
      channel: mention,
      permissions: missing
        .map((name) => t(`replies:feed.permission.${PERMISSION_LABEL_KEYS[name]}`))
        .join(t('replies:feed.permission_separator')),
    });
  }
  return gate;
};

export const reportFeedPanelError = async (
  interaction: FeedInteraction,
  bot: BaseBot,
  error: unknown,
): Promise<void> => {
  if (!(error instanceof FeedPanelError) && !(error instanceof FeedPanelNotice)) {
    await replyForError(interaction, bot, error, 'replies:feed.failed', interaction.guildId);
    return;
  }
  const t = bindTranslator(bot.translator);
  const content =
    error instanceof FeedPanelNotice
      ? t(error.key, error.params)
      : t(`replies:feed.panel.${error.reason}`);
  // Component errors leave the draft intact, including when another actor clicks it.
  if (interaction.isChatInputCommand()) {
    await interaction.editReply({ content, components: [], allowedMentions: { parse: [] } });
  } else if (interaction.deferred || interaction.replied) {
    await interaction.followUp({
      content,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  } else {
    await interaction.reply({
      content,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
};
