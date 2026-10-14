/**
 * Plain-JSON views of stored documents. Driver values (ObjectId, Long,
 * Decimal128, Binary) and dates become strings so a document renders as
 * readable JSON and survives `JSON.stringify`.
 */
import type { InspectDocument } from '../../persistence/repositories/db-inspect.repo';

type Bson = { readonly _bsontype?: unknown; toString(): string };

const bsonType = (value: object): string | undefined => {
  const type = (value as Bson)._bsontype;
  return typeof type === 'string' ? type : undefined;
};

/** `value` with every driver type replaced by a JSON-safe equivalent. */
export const toPlain = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? value.toString() : value;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  }
  const type = bsonType(value);
  if (type === 'Binary') return `<binary ${(value as { length(): number }).length()} bytes>`;
  if (type !== undefined) return (value as Bson).toString();
  if (value instanceof Uint8Array) return `<binary ${value.byteLength} bytes>`;
  if (Array.isArray(value)) return value.map(toPlain);
  if (value instanceof Map) {
    return Object.fromEntries([...value].map(([key, entry]) => [String(key), toPlain(entry)]));
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toPlain(entry)]));
};

/** A document as indented JSON. */
export const toJson = (document: InspectDocument): string =>
  JSON.stringify(toPlain(document), null, 2);

/** A document's `_id` as the string `/db get` accepts. */
export const idString = (document: InspectDocument): string => {
  const plain = toPlain(document['_id']);
  return typeof plain === 'string' ? plain : JSON.stringify(plain);
};

/** The value at a dotted path, or `undefined` when any segment is missing. */
export const valueAt = (document: InspectDocument, path: string): unknown => {
  let current: unknown = document;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = current instanceof Map ? current.get(segment) : (current as InspectDocument)[segment];
  }
  return current;
};
