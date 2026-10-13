/**
 * `AiUsageRepo` — per-member AI request log for rate limiting.
 *
 * **Error boundary**: every method returns `Result<T, DatabaseError>`.
 */
import type { DatabaseError } from '../../core/errors/external-service-error';
import { err, ok, type Result } from '../../core/result';
import type { GuildConnection } from '../connection';
import { databaseErrorFrom } from '../error-translator';

export interface UsageWindow {
  readonly count: number;
  /** The earliest request in the window; it is the next to age out. */
  readonly oldest?: Date;
}

export interface AiUsageRepo {
  /** Record one request by `userId` at `at`. */
  record(userId: string, at: Date): Promise<Result<void, DatabaseError>>;
  /** Requests by `userId` at or after `since`. */
  windowSince(userId: string, since: Date): Promise<Result<UsageWindow, DatabaseError>>;
}

export class MongoAiUsageRepo implements AiUsageRepo {
  constructor(private readonly conn: GuildConnection) {}

  public async record(userId: string, at: Date): Promise<Result<void, DatabaseError>> {
    try {
      await this.conn.models.AiUsage.create({ user_id: userId, at });
      return ok(undefined);
    } catch (rawErr: unknown) {
      return err(databaseErrorFrom(rawErr, { operation: 'MongoAiUsageRepo.record' }));
    }
  }

  public async windowSince(
    userId: string,
    since: Date,
  ): Promise<Result<UsageWindow, DatabaseError>> {
    try {
      const filter = { user_id: userId, at: { $gte: since } };
      const [count, oldest] = await Promise.all([
        this.conn.models.AiUsage.countDocuments(filter).exec(),
        this.conn.models.AiUsage.findOne(filter).sort({ at: 1 }).lean<{ at: Date }>().exec(),
      ]);
      return ok(oldest ? { count, oldest: oldest.at } : { count });
    } catch (rawErr: unknown) {
      return err(databaseErrorFrom(rawErr, { operation: 'MongoAiUsageRepo.windowSince' }));
    }
  }
}
