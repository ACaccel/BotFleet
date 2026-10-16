/**
 * Read-only access to any collection of one database, for `/db`.
 *
 * Not part of `buildRepos`: it runs on the inspection client's read-only
 * account (see `infra/mongo/inspect-connection.ts`) rather than a guild
 * connection, and reads collections by name, including ones no schema
 * describes. Every call carries `maxTimeMS`, so an unindexed filter on a
 * large collection is stopped instead of loading the server.
 *
 * Conditions arrive already validated and typed by the application layer;
 * values are only ever placed as literals, never as query operators.
 */
import mongoose, { type mongo } from 'mongoose';

import type { DatabaseError } from '../../core/errors/external-service-error';
import { err, ok, type Result } from '../../core/result';
import { databaseErrorFrom } from '../error-translator';

/** `substring` matches a string field case-insensitively; `eq` on an array matches an element. */
type InspectOperator = 'eq' | 'substring' | 'gt' | 'lt' | 'exists';

/** An ObjectId given by its hex string, so callers need no driver types. */
interface InspectObjectId {
  readonly objectId: string;
}

export type InspectValue = string | number | boolean | Date | InspectObjectId;

export interface InspectCondition {
  readonly field: string;
  readonly operator: InspectOperator;
  /** For `exists`, whether the field must be present. */
  readonly value: InspectValue;
}

export interface InspectSort {
  readonly field: string;
  readonly direction: 1 | -1;
}

export interface InspectQuery {
  readonly collection: string;
  readonly condition?: InspectCondition;
  readonly sort: InspectSort;
  readonly skip: number;
  readonly limit: number;
}

export type InspectDocument = Readonly<Record<string, unknown>>;

export interface InspectCollectionInfo {
  readonly name: string;
  readonly estimatedCount: number;
}

export interface InspectCollectionStats {
  readonly name: string;
  readonly count: number;
  /** Uncompressed document bytes. */
  readonly size: number;
  readonly storageSize: number;
  readonly indexCount: number;
  readonly indexSize: number;
}

export interface InspectIndex {
  readonly name: string;
  readonly keys: readonly string[];
}

export interface InspectCount {
  readonly count: number;
  /** More documents match than were counted. */
  readonly capped: boolean;
}

export interface InspectValueCount {
  readonly value: unknown;
  readonly count: number;
}

export interface DbInspectRepo {
  /** Collections (not views or `system.*`), by name, with estimated document counts. */
  listCollections(): Promise<Result<readonly InspectCollectionInfo[], DatabaseError>>;
  /** Storage statistics of every collection. */
  collectionStats(): Promise<Result<readonly InspectCollectionStats[], DatabaseError>>;
  indexes(collection: string): Promise<Result<readonly InspectIndex[], DatabaseError>>;
  find(query: InspectQuery): Promise<Result<readonly InspectDocument[], DatabaseError>>;
  /** Matching documents counted up to `cap`; an estimate when there is no condition. */
  count(
    collection: string,
    condition: InspectCondition | undefined,
    cap: number,
  ): Promise<Result<InspectCount, DatabaseError>>;
  /** The document whose `_id` is `id` as a string or, when it parses, an ObjectId. */
  findById(
    collection: string,
    id: string,
  ): Promise<Result<InspectDocument | undefined, DatabaseError>>;
  /**
   * The most frequent values of `field`, optionally only string values
   * starting with `prefix`; `unwind` counts array elements individually.
   */
  topValues(
    collection: string,
    field: string,
    options: { readonly prefix?: string; readonly unwind: boolean; readonly limit: number },
  ): Promise<Result<readonly InspectValueCount[], DatabaseError>>;
}

const SAFE_FIELD = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;

const requireSafeField = (field: string): string => {
  if (!SAFE_FIELD.test(field)) throw new TypeError(`unsafe inspection field: "${field}"`);
  return field;
};

/** Escape every regular-expression metacharacter so `text` matches literally. */
export const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const OBJECT_ID = /^[0-9a-f]{24}$/i;

const driverValue = (value: InspectValue): string | number | boolean | Date | mongo.ObjectId => {
  if (typeof value !== 'object' || value instanceof Date) return value;
  if (!OBJECT_ID.test(value.objectId)) throw new TypeError('objectId needs 24 hex digits');
  return new mongoose.mongo.ObjectId(value.objectId);
};

/** The MongoDB filter for one validated condition. */
export const filterFor = (
  condition: InspectCondition | undefined,
): mongo.Filter<mongo.Document> => {
  if (condition === undefined) return {};
  const field = requireSafeField(condition.field);
  const value = driverValue(condition.value);
  switch (condition.operator) {
    case 'eq':
      return { [field]: value };
    case 'substring':
      if (typeof value !== 'string') throw new TypeError('substring needs a string value');
      return { [field]: { $regex: escapeRegex(value), $options: 'i' } };
    case 'gt':
      return { [field]: { $gt: value } };
    case 'lt':
      return { [field]: { $lt: value } };
    case 'exists':
      return { [field]: { $exists: value === true } };
  }
};

interface CollStatsResult {
  readonly storageStats?: {
    readonly count?: number;
    readonly size?: number;
    readonly storageSize?: number;
    readonly nindexes?: number;
    readonly totalIndexSize?: number;
  };
}

export class MongoDbInspectRepo implements DbInspectRepo {
  public constructor(
    private readonly db: mongo.Db,
    private readonly maxTimeMS: number,
  ) {}

  private collection(name: string): mongo.Collection {
    return this.db.collection(name);
  }

  private failure(operation: string, raw: unknown, input: Record<string, unknown>) {
    return err(databaseErrorFrom(raw, { operation: `MongoDbInspectRepo.${operation}`, input }));
  }

  private async collectionNames(): Promise<string[]> {
    const entries = await this.db
      .listCollections({}, { nameOnly: false, authorizedCollections: true })
      .toArray();
    return entries
      .filter((entry) => entry.type === 'collection' && !entry.name.startsWith('system.'))
      .map((entry) => entry.name)
      .sort();
  }

  public async listCollections(): Promise<Result<readonly InspectCollectionInfo[], DatabaseError>> {
    try {
      const names = await this.collectionNames();
      const counts = await Promise.all(
        names.map((name) =>
          this.collection(name).estimatedDocumentCount({ maxTimeMS: this.maxTimeMS }),
        ),
      );
      return ok(names.map((name, i) => ({ name, estimatedCount: counts[i] ?? 0 })));
    } catch (raw) {
      return this.failure('listCollections', raw, { database: this.db.databaseName });
    }
  }

  public async collectionStats(): Promise<
    Result<readonly InspectCollectionStats[], DatabaseError>
  > {
    try {
      const names = await this.collectionNames();
      const stats = await Promise.all(
        names.map(async (name) => {
          const [result] = await this.collection(name)
            .aggregate<CollStatsResult>([{ $collStats: { storageStats: {} } }], {
              maxTimeMS: this.maxTimeMS,
            })
            .toArray();
          const storage = result?.storageStats ?? {};
          return {
            name,
            count: storage.count ?? 0,
            size: storage.size ?? 0,
            storageSize: storage.storageSize ?? 0,
            indexCount: storage.nindexes ?? 0,
            indexSize: storage.totalIndexSize ?? 0,
          };
        }),
      );
      return ok(stats);
    } catch (raw) {
      return this.failure('collectionStats', raw, { database: this.db.databaseName });
    }
  }

  public async indexes(
    collection: string,
  ): Promise<Result<readonly InspectIndex[], DatabaseError>> {
    try {
      const entries = await this.collection(collection).listIndexes().toArray();
      return ok(
        entries.map((entry) => ({
          name: String(entry.name),
          keys: Object.keys((entry.key ?? {}) as Record<string, unknown>),
        })),
      );
    } catch (raw) {
      return this.failure('indexes', raw, { collection });
    }
  }

  public async find(
    query: InspectQuery,
  ): Promise<Result<readonly InspectDocument[], DatabaseError>> {
    try {
      const documents = await this.collection(query.collection)
        .find(filterFor(query.condition), {
          sort: { [requireSafeField(query.sort.field)]: query.sort.direction },
          skip: query.skip,
          limit: query.limit,
          maxTimeMS: this.maxTimeMS,
        })
        .toArray();
      return ok(documents);
    } catch (raw) {
      if (raw instanceof TypeError) throw raw;
      return this.failure('find', raw, { collection: query.collection });
    }
  }

  public async count(
    collection: string,
    condition: InspectCondition | undefined,
    cap: number,
  ): Promise<Result<InspectCount, DatabaseError>> {
    try {
      if (condition === undefined) {
        const count = await this.collection(collection).estimatedDocumentCount({
          maxTimeMS: this.maxTimeMS,
        });
        return ok({ count, capped: false });
      }
      const counted = await this.collection(collection).countDocuments(filterFor(condition), {
        limit: cap + 1,
        maxTimeMS: this.maxTimeMS,
      });
      return ok({ count: Math.min(counted, cap), capped: counted > cap });
    } catch (raw) {
      if (raw instanceof TypeError) throw raw;
      return this.failure('count', raw, { collection });
    }
  }

  public async findById(
    collection: string,
    id: string,
  ): Promise<Result<InspectDocument | undefined, DatabaseError>> {
    const candidates: unknown[] = [id];
    if (OBJECT_ID.test(id)) candidates.push(new mongoose.mongo.ObjectId(id));
    try {
      const document = await this.collection(collection).findOne(
        { _id: { $in: candidates } } as mongo.Filter<mongo.Document>,
        { maxTimeMS: this.maxTimeMS },
      );
      return ok(document ?? undefined);
    } catch (raw) {
      return this.failure('findById', raw, { collection });
    }
  }

  public async topValues(
    collection: string,
    field: string,
    options: { readonly prefix?: string; readonly unwind: boolean; readonly limit: number },
  ): Promise<Result<readonly InspectValueCount[], DatabaseError>> {
    const path = requireSafeField(field);
    const match =
      options.prefix === undefined || options.prefix.length === 0
        ? { [path]: { $ne: null } }
        : { [path]: { $regex: `^${escapeRegex(options.prefix)}` } };
    try {
      const rows = await this.collection(collection)
        .aggregate<{ _id: unknown; count: number }>(
          [
            ...(options.unwind ? [{ $unwind: `$${path}` }] : []),
            { $match: match },
            { $group: { _id: `$${path}`, count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: options.limit },
          ],
          { maxTimeMS: this.maxTimeMS },
        )
        .toArray();
      return ok(rows.map((row) => ({ value: row._id, count: row.count })));
    } catch (raw) {
      return this.failure('topValues', raw, { collection, field: path });
    }
  }
}
