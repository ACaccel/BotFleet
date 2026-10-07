import { MessageFlags } from 'discord.js';
import type { Interaction, Message, PartialMessage } from 'discord.js';
import { z } from 'zod';
import { findThreadMessageSource } from './thread-message-source';

import type { Translator } from '../core/i18n';
import type { Logger } from '../core/logger';
import type { ThreadModerationRepo } from '../persistence/repositories/thread-moderation.repo';

const configSchema = z.object({ enabled: z.boolean() }).strict();

export const parseThreadModerationConfig = (raw: unknown): boolean =>
  raw === undefined ? false : configSchema.parse(raw).enabled;

interface ThreadChannelContext {
  readonly id: string;
  readonly ownerId?: string | null;
  isThread(): boolean;
}

interface Dependencies {
  readonly botId: string;
  readonly logger: Logger;
  readonly translator: Translator;
  readonly getRepo: (
    guildId: string,
  ) =>
    | Pick<ThreadModerationRepo, 'isBlocked' | 'recordMessageSource' | 'findMessageSource'>
    | undefined;
  readonly isAdmin: (userId: string) => boolean;
}

/** Gate before event fan-out so no reply races with message deletion. */
export class ThreadModeration {
  public constructor(private readonly deps: Dependencies) {}

  private async blocked(
    guildId: string | null,
    channel: ThreadChannelContext | null,
    userId: string,
  ): Promise<boolean> {
    if (!guildId || !channel?.isThread()) return false;
    if (channel.ownerId === userId || this.deps.isAdmin(userId)) return false;
    const repo = this.deps.getRepo(guildId);
    if (!repo) throw new Error('Thread moderation repository is unavailable');
    const result = await repo.isBlocked(this.deps.botId, channel.id, userId);
    if (!result.ok) throw result.error;
    return result.value;
  }

  public async allowMessage(
    message: Message | PartialMessage,
    deleteNewMessage: boolean,
  ): Promise<boolean> {
    if (!message.guildId || !message.channel.isThread()) return true;
    let botAuthored = message.author?.bot === true;
    try {
      const resolved = message.partial ? await message.fetch() : message;
      botAuthored = resolved.author.bot;
      const userId = botAuthored
        ? await findThreadMessageSource(
            resolved,
            this.deps.botId,
            this.deps.getRepo(resolved.guildId!),
          )
        : resolved.author.id;
      if (userId === undefined) {
        this.deps.logger.debug(
          { guildId: resolved.guildId, messageId: resolved.id },
          'thread moderation preserved a bot response without an attributable source',
        );
        return true;
      }
      if (!(await this.blocked(resolved.guildId, resolved.channel, userId))) {
        return true;
      }
      if (deleteNewMessage || botAuthored) {
        // Persist before deletion so delayed replies can resolve a removed original.
        try {
          const repo = this.deps.getRepo(resolved.guildId!);
          if (!repo) throw new Error('Thread moderation repository is unavailable');
          const recorded = await repo.recordMessageSource(
            this.deps.botId,
            resolved.channel.id,
            resolved.id,
            userId,
          );
          if (!recorded.ok) throw recorded.error;
        } catch (err) {
          this.deps.logger.error(
            { err, guildId: resolved.guildId, messageId: resolved.id },
            'thread moderation could not preserve a blocked message source',
          );
        }
        try {
          await resolved.delete();
        } catch (err) {
          // Another moderation client may already have removed this message.
          if (!(typeof err === 'object' && err !== null && 'code' in err && err.code === 10008)) {
            this.deps.logger.error(
              { err, guildId: resolved.guildId, messageId: resolved.id },
              'thread moderation could not delete a blocked message',
            );
          }
        }
      }
      return false;
    } catch (err) {
      this.deps.logger.error({ err, guildId: message.guildId }, 'thread moderation lookup failed');
      // Unverified bot origins must never delete unrelated responses; human access stays closed.
      return botAuthored;
    }
  }

  public async allowInteraction(interaction: Interaction): Promise<boolean> {
    let key = 'replies:thread_moderation.blocked';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Leave time for Discord's initial acknowledgement without deferring a
      // command that may need to open a modal or choose its own reply mode.
      const denied = await Promise.race([
        this.interactionBlocked(interaction),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Thread moderation lookup timed out')), 1500);
        }),
      ]);
      if (!denied) {
        return true;
      }
    } catch (err) {
      this.deps.logger.error(
        { err, guildId: interaction.guildId },
        'thread moderation lookup failed',
      );
      key = 'replies:thread_moderation.unavailable';
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (interaction.isAutocomplete()) {
      await interaction.respond([]);
    } else if (interaction.isRepliable()) {
      await interaction.reply({
        content: this.deps.translator.t(key),
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    }
    return false;
  }

  private async interactionBlocked(interaction: Interaction): Promise<boolean> {
    if (!interaction.guildId || this.deps.isAdmin(interaction.user.id)) return false;
    if (!interaction.channelId) throw new Error('Thread moderation channel ID is unavailable');
    const channel =
      interaction.channel ?? (await interaction.client.channels.fetch(interaction.channelId));
    if (!channel) throw new Error('Thread moderation channel is unavailable');
    return this.blocked(interaction.guildId, channel, interaction.user.id);
  }

  public async allowReaction(message: Message | PartialMessage, userId: string): Promise<boolean> {
    try {
      return !(await this.blocked(message.guildId, message.channel, userId));
    } catch (err) {
      this.deps.logger.error({ err, guildId: message.guildId }, 'thread moderation lookup failed');
      return false;
    }
  }
}
