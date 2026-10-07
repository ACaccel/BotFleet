import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type InteractionEditReplyOptions,
} from 'discord.js';
import type { BaseBot } from '@bot';
import { bindTranslator } from '../core/i18n';

export const buildThreadListReply = (
  bot: BaseBot,
  threadId: string,
  actorId: string,
  userIds: readonly string[],
  requestedPage: number,
): InteractionEditReplyOptions => {
  const t = bindTranslator(bot.translator);
  const users = [...userIds].sort();
  const pages = Math.max(1, Math.ceil(users.length / 20));
  const page = Math.min(pages, Math.max(1, requestedPage));
  const button = (label: string, target: number, disabled: boolean): ButtonBuilder =>
    new ButtonBuilder()
      .setCustomId(`thread_list|${actorId}|${threadId}|${target}`)
      .setLabel(label)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled);
  return {
    content:
      users.length === 0
        ? t('replies:thread_moderation.list_empty')
        : [
            t('replies:thread_moderation.list_header', { count: users.length, page, pages }),
            ...users.slice((page - 1) * 20, page * 20).map((id) => `<@${id}> (\`${id}\`)`),
          ].join('\n'),
    allowedMentions: { parse: [] },
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(t('replies:thread_moderation.list_previous'), page - 1, page === 1),
        button(t('replies:thread_moderation.list_refresh'), page, false),
        button(t('replies:thread_moderation.list_next'), page + 1, page === pages),
      ),
    ],
  };
};
