/** The `/db list` panel: one page of summaries, a detail menu and page buttons. */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  escapeMarkdown,
} from 'discord.js';

import { idString } from '../../../application/db-inspect/display';
import { PAGE_SIZE, type QueryPage } from '../../../application/db-inspect/service';
import type { BoundTranslate } from '../../../core/i18n';
import { EMBED_COLORS } from '../../../infra/discord/presentation-colors';

import { encodeDbPageCustomId, encodeDbViewCustomId } from './custom-id';
import {
  MENU_TEXT_LIMIT,
  SUMMARY_PART_LIMIT,
  dbReply,
  formatCount,
  joinLines,
  truncate,
  type DbReply,
} from './text';
import {
  conditionValue,
  fieldMap,
  operatorLabel,
  plainValue,
  sortLabel,
  summaryOf,
} from './values';

const header = (page: QueryPage, guild: string, t: BoundTranslate): string[] => {
  const lines = [t('replies:db_inspect.guild', { guild: escapeMarkdown(guild) })];
  if (page.condition !== undefined) {
    lines.push(
      t('replies:db_inspect.list.filter', {
        field: page.condition.field,
        operator: operatorLabel(page.condition, t),
        value: escapeMarkdown(truncate(conditionValue(page.condition), SUMMARY_PART_LIMIT)),
      }),
    );
  }
  if (page.unindexedFilter) lines.push(t('replies:db_inspect.list.unindexed'));
  return [...lines, ''];
};

const detailMenu = (page: QueryPage, t: BoundTranslate): StringSelectMenuBuilder => {
  const fields = fieldMap(page.fields);
  const offset = page.page * PAGE_SIZE;
  return new StringSelectMenuBuilder()
    .setCustomId(encodeDbViewCustomId(page.token))
    .setPlaceholder(t('replies:db_inspect.list.view_placeholder'))
    .addOptions(
      page.documents.map((document, index) => {
        const summary = summaryOf(document, page.summaryFields, fields, page.names, plainValue);
        return {
          label: truncate(`${offset + index + 1}. ${idString(document)}`, MENU_TEXT_LIMIT),
          value: String(index),
          ...(summary.trim().length === 0
            ? {}
            : { description: truncate(summary, MENU_TEXT_LIMIT) }),
        };
      }),
    );
};

/** ◀ / ▶ naming their target pages, so the two custom IDs always differ. */
const pageButtons = (page: QueryPage): ActionRowBuilder<ButtonBuilder> => {
  const button = (label: string, target: number, disabled: boolean): ButtonBuilder =>
    new ButtonBuilder()
      .setCustomId(encodeDbPageCustomId(page.token, target))
      .setLabel(label)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled);
  const last = page.pageCount - 1;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    button('◀', Math.max(0, page.page - 1), page.page === 0),
    button('▶', Math.min(last, page.page + 1), page.page === last),
  );
};

export const buildListReply = (page: QueryPage, guild: string, t: BoundTranslate): DbReply => {
  const fields = fieldMap(page.fields);
  const offset = page.page * PAGE_SIZE;
  const rows = page.documents.map(
    (document, index) =>
      `\`${offset + index + 1}.\` \`${truncate(idString(document), 40)}\` ${summaryOf(
        document,
        page.summaryFields,
        fields,
        page.names,
      )}`,
  );
  const total = page.total.capped
    ? t('replies:db_inspect.list.total_capped', { count: formatCount(page.total.count) })
    : formatCount(page.total.count);
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLORS.info)
    .setTitle(t('replies:db_inspect.list.title', { collection: page.collection }))
    .setDescription(
      joinLines([
        ...header(page, guild, t),
        ...(rows.length === 0 ? [t('replies:db_inspect.list.empty')] : rows),
      ]),
    )
    .setFooter({
      text: t('replies:db_inspect.list.footer', {
        page: page.page + 1,
        pages: page.pageCount,
        total,
        sort: sortLabel(page.sort, t),
      }),
    });
  const components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];
  if (page.documents.length > 0) {
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(detailMenu(page, t)),
    );
  }
  if (page.pageCount > 1) components.push(pageButtons(page));
  return dbReply([embed], { components });
};
