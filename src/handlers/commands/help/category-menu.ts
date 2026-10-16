import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';

import type { CommandCategory } from '../command';
import { truncate } from './help-presentation';

/** Custom ID of the overview's category menu, routed to `select-menus/help_category`. */
const HELP_CATEGORY_MENU = 'help_category';

/** Menu value that returns from a category page to the overview. */
export const HELP_OVERVIEW_VALUE = 'overview';

/** Discord's maximum select option label length. */
const LABEL_MAX = 100;

/** The overview entry first, then each category that has commands for the viewer. */
export const buildCategoryMenu = (
  categories: readonly CommandCategory[],
  t: (key: string) => string,
): ActionRowBuilder<StringSelectMenuBuilder> => {
  const option = (label: string, value: string): StringSelectMenuOptionBuilder =>
    new StringSelectMenuOptionBuilder().setLabel(truncate(label, LABEL_MAX)).setValue(value);
  const select = new StringSelectMenuBuilder()
    .setCustomId(HELP_CATEGORY_MENU)
    .setPlaceholder(t('replies:help.select_placeholder'))
    .addOptions(
      option(t('replies:help.overview_option'), HELP_OVERVIEW_VALUE),
      ...categories.map((category) => option(t(`replies:help.category.${category}`), category)),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
};
