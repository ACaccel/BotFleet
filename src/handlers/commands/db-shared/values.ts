/** Inline renderings of stored values for `/db` panels. */
import { escapeMarkdown, type Client } from 'discord.js';

import { idString, valueAt } from '../../../application/db-inspect/display';
import type { BoundTranslate } from '../../../core/i18n';
import type { InspectField } from '../../../persistence/inspect/catalog';
import type {
  InspectCondition,
  InspectDocument,
  InspectSort,
} from '../../../persistence/repositories/db-inspect.repo';

import { SUMMARY_PART_LIMIT, truncate } from './text';

/** `Name (id)`, or the ID marked as a guild the bot is not in. */
export const guildLabel = (client: Client, guildId: string, t: BoundTranslate): string => {
  const name = client.guilds.cache.get(guildId)?.name;
  return name === undefined
    ? `${guildId} (${t('replies:db_inspect.not_joined')})`
    : `${name} (${guildId})`;
};

export const discordTime = (milliseconds: number): string =>
  `<t:${Math.floor(milliseconds / 1000)}:f>`;

export const timeOf = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  return undefined;
};

type ValueFormat = (
  value: unknown,
  field: InspectField | undefined,
  names: ReadonlyMap<string, string>,
) => string;

/** One value as short plain text; times are ISO minutes, for select-menu labels. */
export const plainValue: ValueFormat = (value, field, names) => {
  if (value === undefined || value === null) return '—';
  if (field?.type === 'timestamp' || field?.type === 'date') {
    const time = timeOf(value);
    if (time !== undefined) return new Date(time).toISOString().slice(0, 16).replace('T', ' ');
  }
  if (Array.isArray(value)) return `[${value.length}]`;
  if (typeof value === 'string') {
    const name = names.get(value);
    const text = name === undefined ? value : `${name} (${value})`;
    return truncate(text.replace(/\s+/g, ' '), SUMMARY_PART_LIMIT);
  }
  if (typeof value === 'object' && !(value instanceof Date)) {
    const plain = idString({ _id: value });
    return plain.startsWith('{') ? '{…}' : plain;
  }
  return truncate(String(value), SUMMARY_PART_LIMIT);
};

/** One value as short markdown, with Discord timestamps and snowflakes named where known. */
export const formatValue: ValueFormat = (value, field, names) => {
  if (field?.type === 'timestamp' || field?.type === 'date') {
    const time = timeOf(value);
    if (time !== undefined) return discordTime(time);
  }
  const plain = plainValue(value, field, names);
  return plain === '—' ? plain : escapeMarkdown(plain);
};

export const fieldMap = (fields: readonly InspectField[]): ReadonlyMap<string, InspectField> =>
  new Map(fields.map((field) => [field.path, field]));

export const summaryOf = (
  document: InspectDocument,
  summaryFields: readonly string[],
  fields: ReadonlyMap<string, InspectField>,
  names: ReadonlyMap<string, string>,
  format: ValueFormat = formatValue,
): string =>
  summaryFields.map((path) => format(valueAt(document, path), fields.get(path), names)).join(' · ');

export const conditionValue = (condition: InspectCondition): string => {
  const { value } = condition;
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'object' ? value.objectId : String(value);
};

export const operatorLabel = (condition: InspectCondition, t: BoundTranslate): string =>
  t(
    `replies:db_inspect.operators.${condition.operator === 'substring' ? 'contains' : condition.operator}`,
  );

export const sortLabel = (sort: InspectSort, t: BoundTranslate): string =>
  `${sort.field} ${t(`replies:db_inspect.sort.${sort.direction === 1 ? 'asc' : 'desc'}`)}`;
