import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Guild,
  ThreadChannel,
} from 'discord.js';
import type { BaseBot } from '@bot';
import { replyForError } from '../infra/discord/reply-for-error';
import type { ThreadModerationRepo } from '../persistence/repositories/thread-moderation.repo';

export class ThreadManagementError extends Error {
  constructor(public readonly key: string) {
    super(key);
  }
}

/** The `thread` option's thread, or the channel the command ran in when it is omitted. */
export const targetThreadId = (
  interaction: Pick<ChatInputCommandInteraction, 'options' | 'channelId'>,
): string => interaction.options.getChannel('thread')?.id ?? interaction.channelId;

export const resolveManagedThread = async (
  guild: Guild,
  threadId: string,
): Promise<ThreadChannel> => {
  const channel = await guild.channels.fetch(threadId, { force: true });
  if (!channel?.isThread() || channel.guildId !== guild.id) {
    throw new ThreadManagementError('thread_only');
  }
  return channel;
};

/** Grants do not replace Discord's membership and channel access controls. */
export const assertThreadApplicant = async (
  thread: ThreadChannel,
  userId: string,
): Promise<void> => {
  const member = await thread.guild.members.fetch({ user: userId, force: true });
  if (member.user.bot) throw new ThreadManagementError('protected_user');
  const permissions = thread.permissionsFor(member);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel)) {
    throw new ThreadManagementError('claim_no_access');
  }
  if (
    thread.type === ChannelType.PrivateThread &&
    !permissions.has(PermissionFlagsBits.ManageThreads)
  ) {
    const membership = await thread.members.fetch(userId);
    if (membership.id !== userId) throw new ThreadManagementError('claim_no_access');
  }
};

export const requireThreadRepo = (bot: BaseBot, guildId: string): ThreadModerationRepo => {
  if (!bot.threadModerationEnabled) throw new ThreadManagementError('disabled');
  const repo = bot.getRepos(guildId)?.threadModeration;
  if (!repo) throw new ThreadManagementError('unavailable');
  return repo;
};

export const threadManagementFailure = async (
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  bot: BaseBot,
  error: unknown,
): Promise<void> => {
  if (error instanceof ThreadManagementError) {
    await interaction.editReply({
      content: bot.translator?.t(`replies:thread_moderation.${error.key}`) ?? '',
      allowedMentions: { parse: [] },
    });
    return;
  }
  await replyForError(
    interaction,
    bot,
    error,
    'replies:thread_moderation.claim_failed',
    interaction.guildId,
  );
};
