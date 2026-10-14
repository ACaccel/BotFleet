/**
 * `/db` autocomplete: every option offers what exists, so an admin never
 * needs to remember guild IDs, collection names, fields or stored values.
 *
 * Non-admins get no suggestions, so the dropdown cannot leak guild or
 * collection names. A rejected or slow lookup also yields none; the command
 * explains the problem once it is sent.
 */
import type { AutocompleteInteraction } from 'discord.js';
import type { BaseBot } from '@bot';

import { valueAt } from '../../../application/db-inspect/display';
import type { DbInspectService } from '../../../application/db-inspect/service';
import { DomainError } from '../../../core/errors';
import { bindTranslator, type BoundTranslate } from '../../../core/i18n';
import { INSPECT_CATALOG } from '../../../persistence/inspect/catalog';
import { getOptionalString } from '../../../infra/discord/options';
import type { CommandSuggestions } from '../command';
import { chosenDatabase, dbInspectServiceFor } from '../db-shared/access';
import { formatCount } from '../db-shared/text';
import { sortLabel } from '../db-shared/values';

const collectionDescription = (name: string, t: BoundTranslate): string | undefined => {
  if (!INSPECT_CATALOG.has(name)) return t('replies:db_inspect.unregistered');
  const key = `replies:db_inspect.collections.${name}`;
  const text = t(key);
  return text === key ? undefined : text;
};

const suggest = async (
  service: DbInspectService,
  interaction: AutocompleteInteraction,
  t: BoundTranslate,
): Promise<CommandSuggestions> => {
  const focused = interaction.options.getFocused(true);
  const typed = String(focused.value);
  if (focused.name === 'guild') {
    const guilds = await service.suggestGuilds(typed, interaction.guildId);
    return guilds.map((guild) => ({
      name: `${guild.name ?? t('replies:db_inspect.not_joined')} (${guild.id})`,
      value: guild.id,
    }));
  }
  const database = chosenDatabase(interaction);
  if (database === undefined) return [];
  if (focused.name === 'collection') {
    const collections = await service.suggestCollections(database, typed);
    return collections.map((entry) => ({
      name: [
        entry.name,
        collectionDescription(entry.name, t),
        `~${formatCount(entry.estimatedCount)}`,
      ]
        .filter((part) => part !== undefined)
        .join(' · '),
      value: entry.name,
    }));
  }
  const collection = getOptionalString(interaction, 'collection');
  if (collection === undefined || collection.length === 0) return [];
  const field = getOptionalString(interaction, 'field');
  switch (focused.name) {
    case 'field': {
      const fields = await service.suggestFields(database, collection, typed);
      return fields.map((entry) => ({
        name: [
          entry.path,
          entry.type,
          ...(entry.indexed ? [t('replies:db_inspect.indexed')] : []),
        ].join(' · '),
        value: entry.path,
      }));
    }
    case 'operator': {
      const operators = await service.suggestOperators(database, collection, field);
      return operators.map((operator) => ({
        name: t(`replies:db_inspect.operators.${operator}`),
        value: operator,
      }));
    }
    case 'value': {
      const operator = getOptionalString(interaction, 'operator');
      const values = await service.suggestValues(database, collection, field, operator, typed);
      return values.map((entry) => ({ name: entry.label, value: entry.value }));
    }
    case 'sort': {
      const sorts = await service.suggestSorts(database, collection);
      return sorts.map((sort) => ({
        name: sortLabel(sort, t),
        value: `${sort.field}:${sort.direction === 1 ? 'asc' : 'desc'}`,
      }));
    }
    case 'id': {
      const documents = await service.suggestIds(database, collection, typed);
      const summaryFields = INSPECT_CATALOG.get(collection)?.summaryFields ?? [];
      return documents
        .filter((entry) => entry.id.length <= 100)
        .map((entry) => {
          const summary = summaryFields
            .map((path) => valueAt(entry.document, path))
            .filter((value) => typeof value === 'string' || typeof value === 'number')
            .map((value) => String(value).replace(/\s+/g, ' '))
            .join(' · ');
          return {
            name: summary.length === 0 ? entry.id : `${entry.id} · ${summary}`,
            value: entry.id,
          };
        });
    }
    default:
      return [];
  }
};

export const suggestDbOptions = async (
  interaction: AutocompleteInteraction,
  bot: BaseBot,
): Promise<CommandSuggestions> => {
  const service = dbInspectServiceFor(bot, interaction.user.id);
  if (service === undefined) return [];
  try {
    return await suggest(service, interaction, bindTranslator(bot.translator));
  } catch (error) {
    // Expected rejections (an unknown guild typed so far, a slow query) are
    // not failures; logging them would write a line per keystroke.
    if (error instanceof DomainError) return [];
    throw error;
  }
};
