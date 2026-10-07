import { MessageFlags, PermissionFlagsBits, type ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { canManageThread } from '../thread-moderation-access';
import { buildThreadListReply } from '../thread-list-view';
import { logError } from '@core/logger';
import { replyForError } from '../../infra/discord/reply-for-error';

const MAX_USERS = 20;

const parseUsers = (input: string): string[] | undefined => {
  const tokens = input.trim().split(/[\s,]+/u);
  const ids: string[] = [];
  for (const token of tokens) {
    const match = /^(?:<@!?(\d{17,20})>|(\d{17,20}))$/u.exec(token);
    const id = match?.[1] ?? match?.[2];
    if (id === undefined || BigInt(id) > 18_446_744_073_709_551_615n) return undefined;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.length > 0 && ids.length <= MAX_USERS ? ids : undefined;
};

export const executeThreadModeration = async (
  interaction: ChatInputCommandInteraction,
  bot: BaseBot,
  blocked: boolean | 'list',
): Promise<void> => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const reply = async (key: string, count?: number): Promise<void> => {
    await interaction.editReply({
      content: bot.translator?.t(`replies:thread_moderation.${key}`, { count: count ?? 0 }) ?? '',
      allowedMentions: { parse: [] },
    });
  };
  try {
    if (!bot.threadModerationEnabled) {
      await reply('disabled');
      return;
    }
    if (!interaction.guild || !interaction.channel?.isThread()) {
      await reply('thread_only');
      return;
    }
    // Refresh the owner before authorizing; cached thread metadata can be stale.
    const thread = await interaction.channel.fetch();
    const repos = bot.getRepos(interaction.guild.id);
    if (repos === undefined) {
      await reply('unavailable');
      return;
    }
    if (!(await canManageThread(bot, interaction.guild.id, thread, interaction.user.id))) {
      await reply('forbidden');
      return;
    }
    if (blocked === 'list') {
      await listThreadRestrictions(interaction, bot, interaction.guild.id, thread.id);
      return;
    }
    const userIds = parseUsers(interaction.options.getString('users', true));
    if (userIds === undefined) {
      await reply('invalid_users');
      return;
    }
    if (blocked) {
      const me = await interaction.guild.members.fetchMe();
      if (
        !thread
          .permissionsFor(me)
          ?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageMessages])
      ) {
        await reply('missing_permissions');
        return;
      }
      for (const userId of userIds) {
        if (userId === thread.ownerId || bot.isAdmin(userId) || userId === bot.clientId) {
          await reply('protected_user');
          return;
        }
        const manager = await repos.threadModeration.isManager(bot.clientId, thread.id, userId);
        if (!manager.ok) throw manager.error;
        if (manager.value) {
          await reply('protected_user');
          return;
        }
        const member = await interaction.guild.members.fetch({ user: userId, force: true });
        if (member.user.bot) {
          await reply('protected_user');
          return;
        }
      }
    }
    const result =
      bot.isAdmin(interaction.user.id) || thread.ownerId === interaction.user.id
        ? await repos.threadModeration.setBlocked(bot.clientId, thread.id, userIds, blocked)
        : await repos.threadModeration.setBlocked(
            bot.clientId,
            thread.id,
            userIds,
            blocked,
            interaction.user.id,
          );
    if (!result.ok) throw result.error;
    await reply(blocked ? 'banned' : 'allowed', userIds.length);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 10007) {
      logError(bot.logger, interaction.guildId, error);
      await reply('unknown_member');
      return;
    }
    await replyForError(
      interaction,
      bot,
      error,
      blocked === 'list'
        ? 'replies:thread_moderation.list_failed'
        : 'replies:thread_moderation.failed',
      interaction.guildId,
    );
  }
};

const listThreadRestrictions = async (
  interaction: ChatInputCommandInteraction,
  bot: BaseBot,
  guildId: string,
  threadId: string,
): Promise<void> => {
  const reply = async (content: string): Promise<void> => {
    await interaction.editReply({ content, allowedMentions: { parse: [] } });
  };
  const repos = bot.getRepos(guildId);
  if (!repos) {
    await reply(bot.translator?.t('replies:thread_moderation.unavailable') ?? '');
    return;
  }
  const result = await repos.threadModeration.listBlocked(bot.clientId, threadId);
  if (!result.ok) throw result.error;
  await interaction.editReply(
    buildThreadListReply(bot, threadId, interaction.user.id, result.value, 1),
  );
};
