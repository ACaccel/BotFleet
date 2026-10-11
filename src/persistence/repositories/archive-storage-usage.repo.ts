import type { Connection } from 'mongoose';
import { z } from 'zod';
import type { ArchiveHostUsage } from '../../core/archive/types';

const usageSchema = z.object({
  usedBytes: z.number().int().nonnegative(),
  budgetBytes: z.number().int().positive(),
  measuredAt: z.number().int().nonnegative(),
  stableMeasuredAt: z.number().int().nonnegative().optional(),
});

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
// Fails to compile when the stored shape and the domain type drift apart.
const schemaMatchesType: Equal<Readonly<z.infer<typeof usageSchema>>, ArchiveHostUsage> = true;
void schemaMatchesType;

/** The worker's latest host storage sample and the archive's database footprint. */
export interface ArchiveStorageUsageRepo {
  write(usage: ArchiveHostUsage): Promise<void>;
  read(): Promise<ArchiveHostUsage | undefined>;
  archiveBytes(): Promise<number | undefined>;
}

/**
 * Persists the worker's host sample (`archive_storage_usage`) so `/archive status`
 * can show it without walking the storage roots itself; the walk covers the whole
 * Mongo data directory.
 */
export class MongoArchiveStorageUsageRepo implements ArchiveStorageUsageRepo {
  public constructor(private readonly connection: Connection) {}

  private collection() {
    return this.connection.collection<ArchiveHostUsage & { _id: string }>('archive_storage_usage');
  }

  public async write(usage: ArchiveHostUsage): Promise<void> {
    await this.collection().updateOne(
      { _id: 'host' },
      {
        $set: {
          usedBytes: usage.usedBytes,
          budgetBytes: usage.budgetBytes,
          measuredAt: usage.measuredAt,
          ...(usage.stableMeasuredAt === undefined
            ? {}
            : { stableMeasuredAt: usage.stableMeasuredAt }),
        },
      },
      { upsert: true },
    );
  }

  /** A missing or malformed sample reads as unknown. */
  public async read(): Promise<ArchiveHostUsage | undefined> {
    const parsed = usageSchema.safeParse(
      await this.collection().findOne({ _id: 'host' }, { projection: { _id: 0 } }),
    );
    return parsed.success ? parsed.data : undefined;
  }

  /**
   * Bytes the message backup occupies in this guild's database: data and indexes of
   * `messages` and every `archive_*` collection; `undefined` without an open database.
   */
  public async archiveBytes(): Promise<number | undefined> {
    const db = this.connection.db;
    if (db === undefined) return undefined;
    const names = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((collection) => collection.name)
      .filter((name) => name === 'messages' || name.startsWith('archive_'));
    let bytes = 0;
    for (const name of names) {
      const [stats] = await db
        .collection(name)
        .aggregate<{ storageStats?: { storageSize?: number; totalIndexSize?: number } }>(
          [{ $collStats: { storageStats: {} } }],
          { maxTimeMS: 5000 },
        )
        .toArray();
      bytes += (stats?.storageStats?.storageSize ?? 0) + (stats?.storageStats?.totalIndexSize ?? 0);
    }
    return bytes;
  }
}
