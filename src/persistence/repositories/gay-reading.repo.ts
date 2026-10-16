import type { DatabaseError } from '../../core/errors/external-service-error';
import { err, ok, type Result } from '../../core/result';
import type { GuildConnection } from '../connection';
import { databaseErrorFrom } from '../error-translator';
import type { GayReadingDoc } from '../schemas/gay-reading.schema';

export interface StoredGayReading {
  readonly percent: number;
  readonly commentKey: string;
}

export interface GayReadingRepo {
  find(key: string): Promise<Result<StoredGayReading | undefined, DatabaseError>>;
  /** Atomic first-writer wins, including concurrent calls from different bots. */
  remember(
    key: string,
    reading: StoredGayReading,
    expiresAt: Date,
  ): Promise<Result<StoredGayReading, DatabaseError>>;
}

const QUERY_OPTIONS = { maxTimeMS: 500, timeoutMS: 500 } as const;

export class MongoGayReadingRepo implements GayReadingRepo {
  public constructor(private readonly conn: GuildConnection) {}

  public async find(key: string): Promise<Result<StoredGayReading | undefined, DatabaseError>> {
    try {
      const db = this.conn.connection.db;
      if (db === undefined) throw new Error('Daily reading database is unavailable');
      const doc = await db
        .collection<GayReadingDoc>('gay_readings')
        .findOne({ _id: key }, { ...QUERY_OPTIONS, projection: { percent: 1, commentKey: 1 } });
      return ok(doc === null ? undefined : this.readingOf(doc));
    } catch (error: unknown) {
      return err(databaseErrorFrom(error, { operation: 'MongoGayReadingRepo.find' }));
    }
  }

  public async remember(
    key: string,
    reading: StoredGayReading,
    expiresAt: Date,
  ): Promise<Result<StoredGayReading, DatabaseError>> {
    try {
      const db = this.conn.connection.db;
      if (db === undefined) throw new Error('Daily reading database is unavailable');
      const doc = await db
        .collection<GayReadingDoc>('gay_readings')
        .findOneAndUpdate(
          { _id: key },
          { $setOnInsert: { ...reading, expiresAt } },
          { ...QUERY_OPTIONS, upsert: true, returnDocument: 'after' },
        );
      if (doc === null) throw new Error('Daily reading was not stored');
      return ok(this.readingOf(doc));
    } catch (error: unknown) {
      // An upsert race can lose the unique-key insert; use the winning snapshot.
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
        const winner = await this.find(key);
        if (winner.ok && winner.value !== undefined) return ok(winner.value);
      }
      return err(databaseErrorFrom(error, { operation: 'MongoGayReadingRepo.remember' }));
    }
  }

  private readingOf(doc: StoredGayReading): StoredGayReading {
    if (
      !Number.isInteger(doc.percent) ||
      doc.percent < 0 ||
      doc.percent > 100 ||
      !/^replies:gay\.(single|pair)_(low|mid|high)_[12]$/.test(doc.commentKey)
    )
      throw new Error('Invalid stored daily reading');
    return { percent: doc.percent, commentKey: doc.commentKey };
  }
}
