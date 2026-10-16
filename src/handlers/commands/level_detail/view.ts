/**
 * Discord messages for `/level_detail`, shared by the command and the
 * `level_page` button so a page renders the same either way.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  escapeMarkdown,
  type InteractionEditReplyOptions,
} from 'discord.js';
import type { BoundTranslate } from '../../../core/i18n';
import { EMBED_COLORS } from '../../../infra/discord/presentation-colors';
import type { Mee6Player } from '../mee6-shared/leaderboard';
import { encodeLevelPageCustomId } from './custom-id';
import { formatCardFields, formatLeaderboardPage, formatNumber } from './format';

const footer = (t: BoundTranslate, total: number): { text: string } => ({
  text: t('replies:level_detail.footer', { total: formatNumber(total) }),
});

/**
 * One leaderboard page with ◀ / ▶ buttons bound to `invokerId`. Each
 * button names its target page, so the two ids always differ.
 */
export const buildLeaderboardReply = (
  players: readonly Mee6Player[],
  requestedPage: number,
  invokerId: string,
  t: BoundTranslate,
  highlightRank?: number,
): InteractionEditReplyOptions => {
  const { page, pages, description } = formatLeaderboardPage(
    players,
    requestedPage,
    t,
    highlightRank,
  );
  const button = (label: string, target: number, disabled: boolean): ButtonBuilder =>
    new ButtonBuilder()
      .setCustomId(encodeLevelPageCustomId({ invokerId, page: target }))
      .setLabel(label)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled);
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLORS.info)
    .setTitle(t('replies:level_detail.page_title', { page, pages }))
    .setDescription(description)
    .setFooter(footer(t, players.length));
  return {
    // Clears text an earlier error reply may have left on the message.
    content: '',
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button('◀', page - 1, page === 1),
        button('▶', page + 1, page === pages),
      ),
    ],
    allowedMentions: { parse: [] },
  };
};

/** A ranked member's personal card; `index` is their position in `players`. */
export const buildMemberCard = (
  players: readonly Mee6Player[],
  index: number,
  t: BoundTranslate,
  member: { readonly name: string; readonly avatarUrl: string },
): EmbedBuilder =>
  new EmbedBuilder()
    .setColor(EMBED_COLORS.info)
    .setTitle(t('replies:level_detail.card_title', { name: escapeMarkdown(member.name) }))
    .setThumbnail(member.avatarUrl)
    .addFields(formatCardFields(players, index, t))
    .setFooter(footer(t, players.length));
