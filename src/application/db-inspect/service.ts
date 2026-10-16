/**
 * `/db` use cases: list guild databases and collections, describe and count
 * them, page through query results and show single documents.
 *
 * Every read goes through a {@link DbInspectRepo} on the read-only inspection
 * account. Authorization is the caller's job (bot admins only); this service
 * validates targets, filters and sorts, keeps paging state, and writes one
 * audit line per read without the results.
 */
import { DbInspectError } from '../../core/errors';
import { logSystem, ops, type Logger } from '../../core/logger';
import { unwrap } from '../../core/result';
import {
  INSPECT_CATALOG,
  type InspectCollectionSpec,
  type InspectField,
} from '../../persistence/inspect/catalog';
import type {
  DbInspectRepo,
  InspectCollectionStats,
  InspectCondition,
  InspectCount,
  InspectDocument,
  InspectIndex,
  InspectSort,
} from '../../persistence/repositories/db-inspect.repo';

import { idString, valueAt } from './display';
import {
  FILTER_OPERATORS,
  MAX_FILTER_VALUE_LENGTH,
  inferFields,
  operatorsFor,
  parseFilter,
  type FilterInput,
  type FilterOperator,
} from './fields';
import { QuerySessionStore, type QuerySession } from './session-store';

export const PAGE_SIZE = 10;
/** Paging stops here; a narrower filter reaches the rest. */
const MAX_RESULT_OFFSET = 10_000;
/** Filtered counts stop here and render as "at least". */
const COUNT_CAP = 10_000;
const QUERY_TIME_LIMIT_MS = 5_000;
/** Autocomplete must answer within Discord's three-second window. */
const SUGGESTION_TIME_LIMIT_MS = 1_500;
const SAMPLE_SIZE = 20;
const SUGGESTION_LIMIT = 25;
const TARGET_CACHE_TTL_MS = 60_000;
/** Autocomplete asks per keystroke; the database list changes only when a guild is added. */
const DATABASE_CACHE_TTL_MS = 30_000;
/** Users not cached are fetched from Discord, at most this many per view. */
const USER_FETCH_LIMIT = 10;

/** Discord names for snowflakes; a port so the service never holds the client. */
export interface DiscordDirectory {
  guildName(guildId: string): string | undefined;
  channelName(channelId: string): string | undefined;
  roleName(guildId: string, roleId: string): string | undefined;
  /** Cached name, or fetched from Discord when `fetch` is set. */
  userName(userId: string, fetch: boolean): Promise<string | undefined>;
}

interface GuildDatabaseEntry {
  readonly name: string;
  readonly sizeOnDisk: number;
}

export interface DbInspectServiceDeps {
  readonly listGuildDatabases: () => Promise<readonly GuildDatabaseEntry[]>;
  readonly repo: (database: string, maxTimeMS: number) => DbInspectRepo;
  readonly directory: DiscordDirectory;
  readonly logger: Logger;
  readonly now?: () => number;
}

export interface GuildEntry {
  readonly id: string;
  /** Present when the bot is in the guild. */
  readonly name?: string;
  readonly sizeOnDisk: number;
}

export interface CollectionEntry {
  readonly name: string;
  readonly estimatedCount: number;
  readonly registered: boolean;
}

export interface CollectionStatsEntry extends InspectCollectionStats {
  readonly registered: boolean;
}

export interface CollectionDescription {
  readonly database: string;
  readonly name: string;
  readonly registered: boolean;
  /** Fields come from stored documents rather than a schema. */
  readonly inferred: boolean;
  readonly fields: readonly InspectField[];
  readonly indexes: readonly InspectIndex[];
  readonly estimatedCount: number;
  /** The newest document, when there is one. */
  readonly sample?: InspectDocument;
}

export interface QueryPage {
  readonly token: string;
  readonly database: string;
  readonly collection: string;
  /** Zero-based. */
  readonly page: number;
  readonly pageCount: number;
  readonly total: InspectCount;
  readonly condition?: InspectCondition;
  readonly sort: InspectSort;
  readonly unindexedFilter: boolean;
  readonly documents: readonly InspectDocument[];
  readonly fields: readonly InspectField[];
  readonly summaryFields: readonly string[];
  /** Names of the Discord entities the summaries refer to, by snowflake. */
  readonly names: ReadonlyMap<string, string>;
}

export interface DocumentView {
  readonly database: string;
  readonly collection: string;
  readonly document: InspectDocument;
  readonly fields: readonly InspectField[];
  readonly names: ReadonlyMap<string, string>;
}

export interface Suggestion {
  readonly label: string;
  readonly value: string;
}

export interface QueryInput {
  readonly userId: string;
  readonly database: string;
  readonly collection: string;
  readonly sort?: string;
  readonly filter: FilterInput;
}

interface Target {
  readonly spec?: InspectCollectionSpec;
  readonly fields: readonly InspectField[];
  readonly indexes: readonly InspectIndex[];
  readonly leadingIndexKeys: ReadonlySet<string>;
  readonly estimatedCount: number;
  readonly summaryFields: readonly string[];
}

const SNOWFLAKE = /^\d{15,21}$/;
const DEFAULT_SORT: InspectSort = { field: '_id', direction: -1 };

const sortValue = (sort: InspectSort): string =>
  `${sort.field}:${sort.direction === 1 ? 'asc' : 'desc'}`;

const matches = (typed: string, ...candidates: readonly string[]): boolean => {
  const needle = typed.trim().toLowerCase();
  return needle.length === 0 || candidates.some((c) => c.toLowerCase().includes(needle));
};

export class DbInspectService {
  private readonly sessions: QuerySessionStore;
  private readonly now: () => number;
  private readonly targets = new Map<string, { target: Target; expiresAt: number }>();
  private databases:
    | { readonly entries: readonly GuildDatabaseEntry[]; readonly expiresAt: number }
    | undefined;

  public constructor(private readonly deps: DbInspectServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.sessions = new QuerySessionStore(this.now);
  }

  // ---- guilds and collections ----

  public async listGuilds(): Promise<readonly GuildEntry[]> {
    const databases = await this.guildDatabases();
    return databases
      .map((database) => {
        const name = this.deps.directory.guildName(database.name);
        return {
          id: database.name,
          sizeOnDisk: database.sizeOnDisk,
          ...(name === undefined ? {} : { name }),
        };
      })
      .sort((a, b) => (a.name ?? '￿').localeCompare(b.name ?? '￿'));
  }

  public async listCollections(database: string): Promise<readonly CollectionEntry[]> {
    await this.requireDatabase(database);
    const collections = unwrap(
      await this.deps.repo(database, QUERY_TIME_LIMIT_MS).listCollections(),
    );
    return collections.map((entry) => ({ ...entry, registered: INSPECT_CATALOG.has(entry.name) }));
  }

  public async stats(userId: string, database: string): Promise<readonly CollectionStatsEntry[]> {
    await this.requireDatabase(database);
    this.audit('stats', { userId, database });
    const stats = unwrap(await this.deps.repo(database, QUERY_TIME_LIMIT_MS).collectionStats());
    return stats
      .map((entry) => ({ ...entry, registered: INSPECT_CATALOG.has(entry.name) }))
      .sort((a, b) => b.storageSize - a.storageSize || a.name.localeCompare(b.name));
  }

  public async describe(
    userId: string,
    database: string,
    collection: string,
  ): Promise<CollectionDescription> {
    await this.requireDatabase(database);
    this.audit('schema', { userId, database, collection });
    const target = await this.target(database, collection, QUERY_TIME_LIMIT_MS, true);
    const [sample] = unwrap(
      await this.deps.repo(database, QUERY_TIME_LIMIT_MS).find({
        collection,
        sort: DEFAULT_SORT,
        skip: 0,
        limit: 1,
      }),
    );
    return {
      database,
      name: collection,
      registered: target.spec !== undefined,
      inferred: target.spec?.fields === undefined,
      fields: target.fields,
      indexes: target.indexes,
      estimatedCount: target.estimatedCount,
      ...(sample === undefined ? {} : { sample }),
    };
  }

  // ---- queries ----

  public async query(input: QueryInput): Promise<QueryPage> {
    const { database, collection } = input;
    await this.requireDatabase(database);
    const target = await this.target(database, collection, QUERY_TIME_LIMIT_MS, true);
    const condition = parseFilter(target.fields, input.filter);
    const sort = this.parseSort(input.sort, target);
    const total = unwrap(
      await this.deps.repo(database, QUERY_TIME_LIMIT_MS).count(collection, condition, COUNT_CAP),
    );
    const session = this.sessions.create({
      userId: input.userId,
      database,
      collection,
      sort,
      total,
      unindexedFilter:
        condition !== undefined &&
        condition.field !== '_id' &&
        !target.leadingIndexKeys.has(condition.field),
      fields: target.fields,
      summaryFields: target.summaryFields,
      ...(condition === undefined ? {} : { condition }),
    });
    this.audit('list', {
      userId: input.userId,
      database,
      collection,
      sort: sortValue(sort),
      ...(condition === undefined ? {} : { filter: this.describeCondition(condition) }),
      matched: total.count,
    });
    return this.loadPage(session, 0);
  }

  /**
   * Reject an expired or foreign session before the caller acknowledges the
   * interaction, so the rejection can be private without touching the panel.
   */
  public assertSession(token: string, userId: string): void {
    this.sessions.require(token, userId);
  }

  /** Another page of a session; only its creator may turn it. */
  public async page(token: string, page: number, userId: string): Promise<QueryPage> {
    return this.loadPage(this.sessions.require(token, userId), page);
  }

  /** The document at `index` on the session's current page. */
  public async documentAt(token: string, index: number, userId: string): Promise<DocumentView> {
    const session = this.sessions.require(token, userId);
    const id = session.pageIds[index];
    if (id === undefined) throw new DbInspectError('DB_INSPECT_SESSION_EXPIRED');
    return this.document(userId, session.database, session.collection, id);
  }

  public async get(
    userId: string,
    database: string,
    collection: string,
    id: string,
  ): Promise<DocumentView> {
    await this.requireDatabase(database);
    await this.requireCollection(database, collection);
    return this.document(userId, database, collection, id);
  }

  // ---- autocomplete ----

  /** Guild databases matching `typed`, the current guild first. */
  public async suggestGuilds(
    typed: string,
    currentGuildId: string | null,
  ): Promise<readonly GuildEntry[]> {
    const guilds = await this.listGuilds();
    const ordered = [
      ...guilds.filter((guild) => guild.id === currentGuildId),
      ...guilds.filter((guild) => guild.id !== currentGuildId),
    ];
    return ordered
      .filter((guild) => matches(typed, guild.id, guild.name ?? ''))
      .slice(0, SUGGESTION_LIMIT);
  }

  public async suggestCollections(database: string, typed: string): Promise<CollectionEntry[]> {
    const collections = await this.listCollections(database);
    return collections.filter((entry) => matches(typed, entry.name)).slice(0, SUGGESTION_LIMIT);
  }

  public async suggestFields(
    database: string,
    collection: string,
    typed: string,
  ): Promise<readonly InspectField[]> {
    await this.requireDatabase(database);
    const target = await this.target(database, collection, SUGGESTION_TIME_LIMIT_MS, false);
    return [...target.fields]
      .filter((field) => matches(typed, field.path))
      .sort((a, b) => Number(b.indexed) - Number(a.indexed))
      .slice(0, SUGGESTION_LIMIT);
  }

  /** The operators the chosen field accepts, or every operator before a field is chosen. */
  public async suggestOperators(
    database: string,
    collection: string,
    fieldPath: string | undefined,
  ): Promise<readonly FilterOperator[]> {
    const field = await this.optionalField(database, collection, fieldPath);
    return field === undefined ? FILTER_OPERATORS : operatorsFor(field);
  }

  public async suggestSorts(database: string, collection: string): Promise<InspectSort[]> {
    await this.requireDatabase(database);
    const target = await this.target(database, collection, SUGGESTION_TIME_LIMIT_MS, false);
    const keys = ['_id', ...[...target.leadingIndexKeys].filter((key) => key !== '_id').sort()];
    return keys
      .flatMap((field): InspectSort[] => [
        { field, direction: -1 },
        { field, direction: 1 },
      ])
      .slice(0, SUGGESTION_LIMIT);
  }

  /**
   * Candidate values for a filter. Enum and boolean fields list every value;
   * other fields list their most frequent stored values, named when they are
   * Discord snowflakes. A slow aggregation yields no suggestions.
   */
  public async suggestValues(
    database: string,
    collection: string,
    fieldPath: string | undefined,
    operator: string | undefined,
    typed: string,
  ): Promise<Suggestion[]> {
    const field = await this.optionalField(database, collection, fieldPath);
    if (field === undefined) return [];
    if (operator === 'exists' || field.type === 'boolean') {
      return ['true', 'false'].map((value) => ({ label: value, value }));
    }
    if (field.enumValues !== undefined) {
      return field.enumValues
        .filter((value) => matches(typed, value))
        .map((value) => ({ label: value, value }));
    }
    if (!['string', 'array', 'number', 'objectId'].includes(field.type)) return [];
    const result = await this.deps
      .repo(database, SUGGESTION_TIME_LIMIT_MS)
      .topValues(collection, field.path, {
        unwind: field.type === 'array',
        limit: SUGGESTION_LIMIT,
        ...(field.type === 'number' || typed.length === 0 ? {} : { prefix: typed }),
      });
    if (!result.ok) return [];
    const values = result.value
      .map((row) => String(row.value))
      .filter((value) => value.length > 0 && value.length <= MAX_FILTER_VALUE_LENGTH);
    const names = await this.namesFor(
      database,
      values.map((value) => ({ field, value })),
      false,
    );
    return values.map((value) => {
      const name = names.get(value);
      return { label: name === undefined ? value : `${name} (${value})`, value };
    });
  }

  /** Newest documents of a collection whose `_id` contains `typed`. */
  public async suggestIds(
    database: string,
    collection: string,
    typed: string,
  ): Promise<readonly { readonly id: string; readonly document: InspectDocument }[]> {
    await this.requireDatabase(database);
    const result = await this.deps.repo(database, SUGGESTION_TIME_LIMIT_MS).find({
      collection,
      sort: DEFAULT_SORT,
      skip: 0,
      limit: SUGGESTION_LIMIT,
    });
    if (!result.ok) return [];
    return result.value
      .map((document) => ({ id: idString(document), document }))
      .filter((entry) => matches(typed, entry.id));
  }

  // ---- internals ----

  private async guildDatabases(): Promise<readonly GuildDatabaseEntry[]> {
    if (this.databases !== undefined && this.databases.expiresAt > this.now()) {
      return this.databases.entries;
    }
    const entries = await this.deps.listGuildDatabases();
    this.databases = { entries, expiresAt: this.now() + DATABASE_CACHE_TTL_MS };
    return entries;
  }

  private async requireDatabase(database: string): Promise<void> {
    const databases = await this.guildDatabases();
    if (!databases.some((entry) => entry.name === database)) {
      throw new DbInspectError('DB_INSPECT_UNKNOWN_GUILD', { guild: database });
    }
  }

  private async requireCollection(database: string, collection: string): Promise<number> {
    const collections = unwrap(
      await this.deps.repo(database, QUERY_TIME_LIMIT_MS).listCollections(),
    );
    const entry = collections.find((candidate) => candidate.name === collection);
    if (entry === undefined) {
      throw new DbInspectError('DB_INSPECT_UNKNOWN_COLLECTION', { collection });
    }
    return entry.estimatedCount;
  }

  /** Fields, indexes and summary layout of a collection, cached briefly. */
  private async target(
    database: string,
    collection: string,
    maxTimeMS: number,
    fresh: boolean,
  ): Promise<Target> {
    const key = `${database}/${collection}`;
    const cached = this.targets.get(key);
    if (!fresh && cached !== undefined && cached.expiresAt > this.now()) return cached.target;
    const estimatedCount = await this.requireCollection(database, collection);
    const repo = this.deps.repo(database, maxTimeMS);
    const indexes = unwrap(await repo.indexes(collection));
    const leadingIndexKeys = new Set(
      indexes.map((index) => index.keys[0]).filter((k): k is string => k !== undefined),
    );
    const spec = INSPECT_CATALOG.get(collection);
    let fields: readonly InspectField[];
    if (spec?.fields !== undefined) {
      fields = spec.fields.map((field) =>
        field.indexed || !leadingIndexKeys.has(field.path) ? field : { ...field, indexed: true },
      );
    } else {
      const sample = unwrap(
        await repo.find({ collection, sort: DEFAULT_SORT, skip: 0, limit: SAMPLE_SIZE }),
      );
      fields = inferFields(sample, leadingIndexKeys);
    }
    const summaryFields =
      spec !== undefined && spec.summaryFields.length > 0
        ? spec.summaryFields
        : fields
            .filter((field) => field.path !== '_id' && !field.path.includes('.'))
            .slice(0, 3)
            .map((field) => field.path);
    const target: Target = {
      fields,
      indexes,
      leadingIndexKeys,
      estimatedCount,
      summaryFields,
      ...(spec === undefined ? {} : { spec }),
    };
    this.targets.set(key, { target, expiresAt: this.now() + TARGET_CACHE_TTL_MS });
    return target;
  }

  private async optionalField(
    database: string,
    collection: string,
    fieldPath: string | undefined,
  ): Promise<InspectField | undefined> {
    if (fieldPath === undefined || fieldPath.length === 0) return undefined;
    await this.requireDatabase(database);
    const target = await this.target(database, collection, SUGGESTION_TIME_LIMIT_MS, false);
    return target.fields.find((field) => field.path === fieldPath);
  }

  private parseSort(raw: string | undefined, target: Target): InspectSort {
    if (raw === undefined || raw.length === 0) return DEFAULT_SORT;
    const match = /^(.+):(asc|desc)$/.exec(raw);
    const field = match?.[1];
    if (field === undefined || (field !== '_id' && !target.leadingIndexKeys.has(field))) {
      throw new DbInspectError('DB_INSPECT_INVALID_SORT', { sort: raw });
    }
    return { field, direction: match?.[2] === 'asc' ? 1 : -1 };
  }

  private async loadPage(session: QuerySession, requested: number): Promise<QueryPage> {
    const reachable = Math.min(session.total.count, MAX_RESULT_OFFSET);
    const pageCount = Math.max(1, Math.ceil(reachable / PAGE_SIZE));
    const page = Math.min(Math.max(0, Math.trunc(requested)), pageCount - 1);
    const documents = unwrap(
      await this.deps.repo(session.database, QUERY_TIME_LIMIT_MS).find({
        collection: session.collection,
        sort: session.sort,
        skip: page * PAGE_SIZE,
        limit: PAGE_SIZE,
        ...(session.condition === undefined ? {} : { condition: session.condition }),
      }),
    );
    session.pageIds = documents.map(idString);
    const summaryRefs = session.fields.filter(
      (field) => field.ref !== undefined && session.summaryFields.includes(field.path),
    );
    const names = await this.namesFor(
      session.database,
      documents.flatMap((document) =>
        summaryRefs.flatMap((field) => this.snowflakesAt(document, field)),
      ),
      true,
    );
    return {
      token: session.token,
      database: session.database,
      collection: session.collection,
      page,
      pageCount,
      total: session.total,
      sort: session.sort,
      unindexedFilter: session.unindexedFilter,
      documents,
      fields: session.fields,
      summaryFields: session.summaryFields,
      names,
      ...(session.condition === undefined ? {} : { condition: session.condition }),
    };
  }

  private async document(
    userId: string,
    database: string,
    collection: string,
    id: string,
  ): Promise<DocumentView> {
    this.audit('get', { userId, database, collection, id });
    const document = unwrap(
      await this.deps.repo(database, QUERY_TIME_LIMIT_MS).findById(collection, id),
    );
    if (document === undefined) throw new DbInspectError('DB_INSPECT_NOT_FOUND', { id });
    const target = await this.target(database, collection, QUERY_TIME_LIMIT_MS, false);
    const refs = target.fields.filter((field) => field.ref !== undefined);
    const names = await this.namesFor(
      database,
      refs.flatMap((field) => this.snowflakesAt(document, field)),
      true,
    );
    return { database, collection, document, fields: target.fields, names };
  }

  private snowflakesAt(
    document: InspectDocument,
    field: InspectField,
  ): { readonly field: InspectField; readonly value: string }[] {
    const value = valueAt(document, field.path);
    const values = Array.isArray(value) ? value : [value];
    return values
      .filter((entry): entry is string => typeof entry === 'string' && SNOWFLAKE.test(entry))
      .map((entry) => ({ field, value: entry }));
  }

  private async namesFor(
    database: string,
    refs: readonly { readonly field: InspectField; readonly value: string }[],
    fetchUsers: boolean,
  ): Promise<ReadonlyMap<string, string>> {
    const names = new Map<string, string>();
    const directory = this.deps.directory;
    let fetches = 0;
    for (const { field, value } of refs) {
      if (names.has(value) || !SNOWFLAKE.test(value)) continue;
      let name: string | undefined;
      switch (field.ref) {
        case 'guild':
          name = directory.guildName(value);
          break;
        case 'channel':
          name = directory.channelName(value);
          break;
        case 'role':
          name = directory.roleName(database, value);
          break;
        case 'user': {
          const fetch = fetchUsers && fetches < USER_FETCH_LIMIT;
          if (fetch) fetches += 1;
          name = await directory.userName(value, fetch);
          break;
        }
        case undefined:
          break;
      }
      if (name !== undefined) names.set(value, name);
    }
    return names;
  }

  private describeCondition(condition: InspectCondition): string {
    const value =
      typeof condition.value === 'object' && !(condition.value instanceof Date)
        ? condition.value.objectId
        : String(condition.value);
    return `${condition.field} ${condition.operator} ${value}`;
  }

  private audit(action: string, fields: Readonly<Record<string, unknown>>): void {
    const logger = this.deps.logger.child({ dbInspect: fields });
    logSystem(logger, ops.dbInspect.read(action));
  }
}
