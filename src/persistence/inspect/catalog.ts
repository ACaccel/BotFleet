/**
 * Catalog of the collections `/db` can describe.
 *
 * Schema-backed collections take their field list straight from the schema
 * registry, so a new model is described without further work; collections
 * that repositories read without a mongoose schema are listed by name and
 * have their fields inferred from stored documents. Anything else on the
 * server is shown as unregistered.
 */
import mongoose, { type Schema, type SchemaType } from 'mongoose';

import { SCHEMAS } from '../schemas';

/**
 * Field types `/db` filters and renders by. `timestamp` is a number holding
 * epoch milliseconds, which the project stores for most times.
 */
export type InspectFieldType =
  | 'string'
  | 'number'
  | 'timestamp'
  | 'boolean'
  | 'date'
  | 'objectId'
  | 'array'
  | 'object'
  | 'mixed';

/** Discord entity a snowflake field refers to, for showing its name. */
export type InspectRefKind = 'user' | 'channel' | 'role' | 'guild';

export interface InspectField {
  /** Dotted document path. */
  readonly path: string;
  readonly type: InspectFieldType;
  /** Allowed values of an enum string field. */
  readonly enumValues?: readonly string[];
  /** The field leads an index, so sorting and equality filters on it are fast. */
  readonly indexed: boolean;
  readonly ref?: InspectRefKind;
}

export interface InspectCollectionSpec {
  readonly name: string;
  /** Declared fields; absent when the collection has no schema and fields are inferred. */
  readonly fields?: readonly InspectField[];
  /** Fields that make up a document's one-line summary, in order. */
  readonly summaryFields: readonly string[];
}

/** Collections that repositories read and write without a mongoose schema. */
const SCHEMALESS_COLLECTIONS: readonly string[] = [
  'archive_control_confirmations',
  'archive_gateway_continuity',
  'archive_gc_checkpoints',
  'archive_periodic_runs',
  'archive_schedule',
  'archive_storage_usage',
];

const SUMMARY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  activities: ['title', 'status', 'starts_at'],
  aiusages: ['user_id', 'at'],
  archive_channels: ['name', 'access', 'observedAt'],
  archive_inbox: ['kind', 'state', 'observedAt'],
  archive_jobs: ['command', 'status', 'createdAt'],
  archive_leases: ['key', 'ownerId', 'acquiredAt'],
  archive_reactions: ['messageId', 'emojiKey', 'chunk'],
  bugtickets: ['number', 'title', 'status'],
  feedsubscriptions: ['platform', 'account', 'channel_id'],
  fetches: ['channel', 'lastMessageID'],
  gay_readings: ['percent', 'commentKey', 'expiresAt'],
  giveaways: ['prize', 'end_time', 'winner_num'],
  guildsettings: ['botId', 'guildId', 'revision'],
  guildsettingsmigrations: ['botId', 'createdAt'],
  messages: ['author.username', 'content', 'createdTimestamp'],
  replies: ['input', 'reply', 'created_by'],
  rollcalls: ['persona', 'closed', 'deadline'],
  temproles: ['role_name', 'expires_at'],
  threadmessagesources: ['thread_id', 'message_id', 'user_id'],
  threadmoderations: ['thread_id', 'bot_id'],
  userapisettings: ['userId', 'provider', 'model'],
};

const USER_FIELD_NAMES = new Set([
  'createdby',
  'closedby',
  'participants',
  'winners',
  'targets',
  'present',
]);

/** Guess the Discord entity behind a field from its name. */
export const refKindFor = (path: string): InspectRefKind | undefined => {
  const segments = path.split('.');
  const last = (segments.at(-1) ?? '').toLowerCase().replace(/_/g, '');
  const parent = (segments.at(-2) ?? '').toLowerCase().replace(/_/g, '');
  const name = last === 'id' && parent.length > 0 ? `${parent}id` : last;
  if (/roleids?$/.test(name)) return 'role';
  if (/guildids?$/.test(name)) return 'guild';
  if (/(channel|thread|parent)ids?$/.test(name)) return 'channel';
  if (/(user|author|creator|owner|reporter|manager|bot)ids?$/.test(name)) return 'user';
  return USER_FIELD_NAMES.has(name) ? 'user' : undefined;
};

const TIMESTAMP_NAME = /([tT]imestamp|_at|At|_time|deadline|Until)$/;

/** A number field with this name holds epoch milliseconds. */
export const isTimestampName = (path: string): boolean => TIMESTAMP_NAME.test(path);

const fieldTypeOf = (path: string, schemaType: SchemaType): InspectFieldType => {
  switch (schemaType.instance) {
    case 'String':
      return 'string';
    case 'Number':
    case 'Decimal128':
      return isTimestampName(path) ? 'timestamp' : 'number';
    case 'Boolean':
      return 'boolean';
    case 'Date':
      return 'date';
    case 'ObjectId':
    case 'ObjectID':
      return 'objectId';
    case 'Array':
      return 'array';
    case 'Embedded':
    case 'Map':
      return 'object';
    default:
      return 'mixed';
  }
};

const enumValuesOf = (schemaType: SchemaType): readonly string[] | undefined => {
  const values = (schemaType as SchemaType & { enumValues?: unknown }).enumValues;
  if (!Array.isArray(values) || values.length === 0) return undefined;
  return values.map(String);
};

const leadingIndexKeys = (schema: Schema): ReadonlySet<string> =>
  new Set(
    schema
      .indexes()
      .map(([keys]) => Object.keys(keys)[0])
      .filter((key): key is string => key !== undefined),
  );

/** Every field a schema declares, single nested subdocuments flattened. */
export const fieldsOfSchema = (schema: Schema): readonly InspectField[] => {
  const indexed = leadingIndexKeys(schema);
  const fields: InspectField[] = [];
  const visit = (current: Schema, prefix: string): void => {
    current.eachPath((name, schemaType) => {
      if (name === '__v' || name.includes('$*')) return;
      const path = `${prefix}${name}`;
      const nested = (schemaType as SchemaType & { schema?: Schema }).schema;
      if (schemaType.instance === 'Embedded' && nested !== undefined) {
        fields.push({ path, type: 'object', indexed: false });
        visit(nested, `${path}.`);
        return;
      }
      const enumValues = enumValuesOf(schemaType);
      const ref = refKindFor(path);
      fields.push({
        path,
        type: fieldTypeOf(path, schemaType),
        indexed: path === '_id' || indexed.has(path),
        ...(enumValues === undefined ? {} : { enumValues }),
        ...(ref === undefined ? {} : { ref }),
      });
    });
  };
  visit(schema, '');
  return fields;
};

const pluralize = mongoose.pluralize() ?? ((name: string) => name);

/** The collection a registry model reads, as mongoose names it. */
const collectionNameOf = (modelName: string, schema: Schema): string => {
  const explicit: unknown = schema.get('collection');
  return typeof explicit === 'string' && explicit.length > 0 ? explicit : pluralize(modelName);
};

const buildCatalog = (): ReadonlyMap<string, InspectCollectionSpec> => {
  const catalog = new Map<string, InspectCollectionSpec>();
  for (const [modelName, schema] of Object.entries(SCHEMAS)) {
    const name = collectionNameOf(modelName, schema as Schema);
    catalog.set(name, {
      name,
      fields: fieldsOfSchema(schema as Schema),
      summaryFields: SUMMARY_FIELDS[name] ?? [],
    });
  }
  for (const name of SCHEMALESS_COLLECTIONS) {
    catalog.set(name, { name, summaryFields: SUMMARY_FIELDS[name] ?? [] });
  }
  return catalog;
};

/** Registered collections by name. */
export const INSPECT_CATALOG: ReadonlyMap<string, InspectCollectionSpec> = buildCatalog();
