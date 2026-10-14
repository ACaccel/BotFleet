/**
 * Field metadata and filter parsing for `/db`.
 *
 * A filter is three structured choices (field, operator, value). The field
 * must be one the collection declares or that its documents show; the
 * operator must suit the field's type; the value is converted to that type.
 * Nothing the member types is ever interpreted as query syntax.
 */
import { DbInspectError } from '../../core/errors';
import {
  isTimestampName,
  refKindFor,
  type InspectField,
  type InspectFieldType,
} from '../../persistence/inspect/catalog';
import type {
  InspectCondition,
  InspectDocument,
  InspectValue,
} from '../../persistence/repositories/db-inspect.repo';

export type FilterOperator = 'eq' | 'contains' | 'gt' | 'lt' | 'exists';

export const FILTER_OPERATORS: readonly FilterOperator[] = ['eq', 'contains', 'gt', 'lt', 'exists'];

/** Longest value a filter accepts; a substring search beyond it is not a lookup. */
export const MAX_FILTER_VALUE_LENGTH = 100;

const OPERATORS_BY_TYPE: Readonly<Record<InspectFieldType, readonly FilterOperator[]>> = {
  string: ['eq', 'contains', 'exists'],
  objectId: ['eq', 'exists'],
  number: ['eq', 'gt', 'lt', 'exists'],
  timestamp: ['eq', 'gt', 'lt', 'exists'],
  date: ['eq', 'gt', 'lt', 'exists'],
  boolean: ['eq', 'exists'],
  array: ['contains', 'exists'],
  object: ['exists'],
  mixed: ['exists'],
};

/** Operators a field accepts; an enum offers exact values only. */
export const operatorsFor = (field: InspectField): readonly FilterOperator[] =>
  field.enumValues === undefined ? OPERATORS_BY_TYPE[field.type] : ['eq', 'exists'];

const isFilterOperator = (value: string): value is FilterOperator =>
  (FILTER_OPERATORS as readonly string[]).includes(value);

const isObjectId = (value: unknown): value is { toHexString(): string } =>
  typeof value === 'object' &&
  value !== null &&
  (value as { _bsontype?: unknown })._bsontype === 'ObjectId';

const typeOfValue = (key: string, value: unknown): InspectFieldType | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return isTimestampName(key) ? 'timestamp' : 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (value instanceof Date) return 'date';
  if (isObjectId(value)) return 'objectId';
  if (Array.isArray(value)) return 'array';
  return typeof value === 'object' ? 'object' : 'mixed';
};

/**
 * Top-level fields seen in `documents`, for a collection without a schema.
 * A field seen with more than one type is `mixed` and cannot be filtered.
 */
export const inferFields = (
  documents: readonly InspectDocument[],
  leadingIndexKeys: ReadonlySet<string>,
): readonly InspectField[] => {
  const seen = new Map<string, Set<InspectFieldType>>();
  for (const document of documents) {
    for (const [key, value] of Object.entries(document)) {
      const types = seen.get(key) ?? new Set<InspectFieldType>();
      const type = typeOfValue(key, value);
      if (type !== undefined) types.add(type);
      seen.set(key, types);
    }
  }
  const fields: InspectField[] = [];
  for (const [path, types] of seen) {
    const [only] = types;
    const type: InspectFieldType = types.size === 1 && only !== undefined ? only : 'mixed';
    const ref = refKindFor(path);
    fields.push({
      path,
      type,
      indexed: path === '_id' || leadingIndexKeys.has(path),
      ...(ref === undefined ? {} : { ref }),
    });
  }
  return fields.sort((a, b) =>
    a.path === '_id' ? -1 : b.path === '_id' ? 1 : a.path.localeCompare(b.path),
  );
};

/** The raw slash-command filter, any part of which may be missing. */
export interface FilterInput {
  readonly field?: string;
  readonly operator?: string;
  readonly value?: string;
}

const invalidValue = (field: InspectField): DbInspectError =>
  new DbInspectError('DB_INSPECT_INVALID_VALUE', { field: field.path, type: field.type });

const parseBoolean = (raw: string, field: InspectField): boolean => {
  const value = raw.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw invalidValue(field);
};

const parseNumber = (raw: string, field: InspectField): number => {
  const value = Number(raw.trim());
  if (raw.trim().length === 0 || !Number.isFinite(value)) throw invalidValue(field);
  return value;
};

/** Epoch milliseconds from digits or a date string (`YYYY-MM-DD` is midnight UTC). */
const parseTime = (raw: string, field: InspectField): number => {
  const text = raw.trim();
  if (/^\d+$/.test(text)) return Number(text);
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) throw invalidValue(field);
  return parsed;
};

const parseValue = (field: InspectField, operator: FilterOperator, raw: string): InspectValue => {
  if (operator === 'exists') return parseBoolean(raw, field);
  if (field.enumValues !== undefined) {
    if (!field.enumValues.includes(raw)) throw invalidValue(field);
    return raw;
  }
  switch (field.type) {
    case 'string':
    case 'array':
      return raw;
    case 'objectId':
      if (!/^[0-9a-f]{24}$/i.test(raw.trim())) throw invalidValue(field);
      return { objectId: raw.trim() };
    case 'number':
      return parseNumber(raw, field);
    case 'timestamp':
      return parseTime(raw, field);
    case 'date':
      return new Date(parseTime(raw, field));
    case 'boolean':
      return parseBoolean(raw, field);
    case 'object':
    case 'mixed':
      throw invalidValue(field);
  }
};

/**
 * The repository condition for a filter, or `undefined` when no part of it
 * was given. A filter with only some parts is rejected rather than guessed.
 */
export const parseFilter = (
  fields: readonly InspectField[],
  input: FilterInput,
): InspectCondition | undefined => {
  const parts = [input.field, input.operator, input.value];
  const given = parts.filter((part) => part !== undefined && part.length > 0).length;
  if (given === 0) return undefined;
  if (given < parts.length) throw new DbInspectError('DB_INSPECT_PARTIAL_FILTER');
  const field = fields.find((candidate) => candidate.path === input.field);
  if (field === undefined) {
    throw new DbInspectError('DB_INSPECT_UNKNOWN_FIELD', { field: input.field ?? '' });
  }
  const operator = input.operator ?? '';
  if (!isFilterOperator(operator) || !operatorsFor(field).includes(operator)) {
    throw new DbInspectError('DB_INSPECT_INVALID_OPERATOR', { field: field.path, operator });
  }
  const raw = input.value ?? '';
  if (raw.length > MAX_FILTER_VALUE_LENGTH) throw invalidValue(field);
  const value = parseValue(field, operator, raw);
  const repoOperator =
    operator === 'contains' ? (field.type === 'array' ? 'eq' : 'substring') : operator;
  return { field: field.path, operator: repoOperator, value };
};
