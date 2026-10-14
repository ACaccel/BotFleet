/**
 * `FeedSubscriptionRepo` — social-feed subscriptions, one document per
 * `(platform, account, channel_id)` triple. The database is the single
 * source of truth for what is subscribed: the slash commands write
 * here, and each poll pass reads the current list, so a subscription
 * takes effect on the next pass without any cross-module notification.
 *
 * The document also carries the polling cursor. The poller advances it
 * only after the matching posts have actually been delivered, so a
 * failed send is retried on the next pass rather than skipped.
 *
 * Error boundary: every method returns `Result<T, DatabaseError>`. A
 * mongoose failure is translated by the shared `databaseErrorFrom`
 * translator and returned as `err`; a missing lookup is a success
 * (`ok(undefined)` / `ok([])`) — an unsubscribed channel is not an
 * error.
 */
import type { Types } from 'mongoose';
import type { DatabaseError } from '../../core/errors/external-service-error';
import { err, ok, type Result } from '../../core/result';
import type { GuildConnection } from '../connection';
import { databaseErrorFrom } from '../error-translator';
import {
  DEFAULT_FEED_MEDIA_FILTER,
  isFeedMediaFilter,
  type FeedMediaFilter,
  type FeedSubscriptionDoc,
  type StoredFeedSubscription,
} from '../schemas/feed-subscription.schema';

/**
 * Filter as supplied by the caller. `media` is always resolved by the
 * command layer (its option carries the default); `keyword` is absent
 * when the subscription does not narrow by text.
 */
export interface FeedSubscriptionFilterInput {
  readonly media: FeedMediaFilter;
  readonly keyword?: string;
}

/**
 * A subscription to create or re-filter. The first three fields are
 * its unique key (plan D8) and mirror the stored snake_case field
 * names, as the other repositories' document-shaped inputs do.
 */
export interface FeedSubscriptionUpsertInput {
  readonly platform: string;
  readonly account: string;
  readonly channel_id: string;
  readonly created_by: string;
  /** Replaces any stored filter wholesale — see {@link FeedSubscriptionRepo.upsert}. */
  readonly filter: FeedSubscriptionFilterInput;
  /** Written on creation only; an existing subscription keeps its cursor. */
  readonly last_seen_id?: string;
  /** Unix **seconds**, matching the upstream post timestamp. */
  readonly last_seen_timestamp?: number;
}

/**
 * Deletion scope. `channelId` is mandatory — unsubscribing is always
 * channel-centric; `platform` and `accounts` narrow it further.
 *
 * Query parameters are camelCase here while document-shaped inputs
 * ({@link FeedSubscriptionUpsertInput}) mirror the stored snake_case
 * field names, matching the convention of the other repositories.
 */
export interface FeedSubscriptionDeleteWhere {
  readonly channelId: string;
  readonly platform?: string;
  /**
   * Accounts to remove, as a set: one invocation of
   * `/feed unsubscribe` may name several. Omit it to cover every
   * account in the channel.
   *
   * An **empty array** is not the same as omitting it — it names no
   * account and therefore matches nothing. That is the safe direction:
   * the alternative, treating it as "no narrowing", would silently turn
   * a request to remove nothing into one that clears the whole channel.
   */
  readonly accounts?: readonly string[];
}

export interface FeedSubscriptionUpsertResult {
  readonly doc: FeedSubscriptionDoc;
  /** `true` when the subscription was created, `false` when only its filter was updated. */
  readonly created: boolean;
}

export interface FeedSubscriptionRepo {
  /** Every subscription in this guild — the poll pass's input. */
  list(): Promise<Result<readonly FeedSubscriptionDoc[], DatabaseError>>;
  /** Subscriptions targeting one channel; `ok([])` when there are none. */
  listByChannel(channelId: string): Promise<Result<readonly FeedSubscriptionDoc[], DatabaseError>>;
  /** Look up one subscription by its key; `ok(undefined)` when absent. */
  find(
    platform: string,
    account: string,
    channelId: string,
  ): Promise<Result<FeedSubscriptionDoc | undefined, DatabaseError>>;
  /**
   * Create the subscription, or update the filter of an existing one.
   *
   * Re-subscribing an existing triple is an update rather than a
   * conflict, so changing a filter needs no unsubscribe first. The
   * creator and the cursor are preserved: `created_by` stays
   * attributable, and resetting the cursor would replay the timeline
   * every time a filter is tweaked.
   *
   * The filter is **replaced wholesale, not merged** — an omitted
   * `keyword` clears a stored one. A caller that wants to change one
   * option while keeping the rest must read the current subscription
   * with {@link FeedSubscriptionRepo.find} and pass a complete filter.
   *
   * A duplicate-key rejection is retried once rather than surfaced. Two
   * members subscribing the same triple at the same moment can both
   * miss the document on the upsert's lookup and race to insert it, and
   * the loser would otherwise read "that already exists" for an
   * operation whose whole contract is that re-subscribing is an update.
   * The retry finds the winner's document and reports `created: false`,
   * which is the truthful answer for the second caller.
   */
  upsert(
    input: FeedSubscriptionUpsertInput,
  ): Promise<Result<FeedSubscriptionUpsertResult, DatabaseError>>;
  /**
   * Delete every subscription matching `where` and return the deleted
   * documents, so the caller can report exactly what it removed.
   *
   * Read-then-delete is not atomic. A concurrent unsubscribe covering
   * the same scope can remove a document between the two steps, in
   * which case the returned list is a superset of what this call
   * actually deleted. That is the benign direction: the poller reads
   * the collection fresh each pass, so no stale subscription survives —
   * only the confirmation message can overstate by one entry.
   */
  deleteWhere(
    where: FeedSubscriptionDeleteWhere,
  ): Promise<Result<readonly FeedSubscriptionDoc[], DatabaseError>>;
  /**
   * Advance one subscription's cursor. Addressed by `_id` because the
   * caller is a poll pass that already holds the document.
   *
   * `lastSeenTimestamp` is unix **seconds** (the upstream post unit),
   * unlike `created_at`, which is milliseconds. A subscription deleted
   * since the pass read it is not an error: the update matches nothing
   * and the call still resolves `ok`.
   */
  advanceCursor(
    id: Types.ObjectId,
    lastSeenId: string,
    lastSeenTimestamp: number,
  ): Promise<Result<void, DatabaseError>>;
}

/**
 * Convert a stored document into the repository's contract: fill the
 * filter defaults that a `lean` read bypasses, reject a `media` value
 * this build does not know, and collapse `null` to `undefined` so an
 * unset cursor has one representation rather than two.
 *
 * This is the only way to obtain a `FeedSubscriptionDoc` from a read,
 * which is what keeps the tightened type honest: a new read method
 * that forgets to call it will not compile.
 */
const normalize = (doc: StoredFeedSubscription): FeedSubscriptionDoc => {
  const { filter, last_seen_id, last_seen_timestamp, ...rest } = doc;
  const storedMedia = filter?.media;
  return {
    ...rest,
    filter: {
      media: isFeedMediaFilter(storedMedia) ? storedMedia : DEFAULT_FEED_MEDIA_FILTER,
      keyword: filter?.keyword ?? undefined,
    },
    last_seen_id: last_seen_id ?? undefined,
    last_seen_timestamp: last_seen_timestamp ?? undefined,
  };
};

/**
 * Mongo query selecting a subset of one channel's subscriptions.
 * Derived from the document type so a renamed field fails to compile
 * rather than silently matching nothing.
 */
type DeleteQuery = Pick<FeedSubscriptionDoc, 'channel_id'> &
  Partial<Pick<FeedSubscriptionDoc, 'platform'>> &
  // `$in` even for a single account, so one code path serves both. The
  // key is still taken from the document type rather than written out,
  // so a renamed `account` field fails here too.
  Partial<Record<keyof Pick<FeedSubscriptionDoc, 'account'>, { readonly $in: readonly string[] }>>;

const buildDeleteQuery = (where: FeedSubscriptionDeleteWhere): DeleteQuery => {
  const query: DeleteQuery = { channel_id: where.channelId };
  if (where.platform !== undefined) query.platform = where.platform;
  if (where.accounts !== undefined) query.account = { $in: [...where.accounts] };
  return query;
};

export class MongoFeedSubscriptionRepo implements FeedSubscriptionRepo {
  constructor(private readonly conn: GuildConnection) {}

  public async list(): Promise<Result<readonly FeedSubscriptionDoc[], DatabaseError>> {
    try {
      const docs = await this.conn.models.FeedSubscription.find({})
        .sort({ platform: 1, account: 1 })
        .lean<StoredFeedSubscription[]>()
        .exec();
      return ok(docs.map(normalize));
    } catch (rawErr: unknown) {
      return err(databaseErrorFrom(rawErr, { operation: 'MongoFeedSubscriptionRepo.list' }));
    }
  }

  public async listByChannel(
    channelId: string,
  ): Promise<Result<readonly FeedSubscriptionDoc[], DatabaseError>> {
    try {
      const docs = await this.conn.models.FeedSubscription.find({ channel_id: channelId })
        .sort({ platform: 1, account: 1 })
        .lean<StoredFeedSubscription[]>()
        .exec();
      return ok(docs.map(normalize));
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoFeedSubscriptionRepo.listByChannel',
          input: { channelId },
        }),
      );
    }
  }

  public async find(
    platform: string,
    account: string,
    channelId: string,
  ): Promise<Result<FeedSubscriptionDoc | undefined, DatabaseError>> {
    try {
      const doc = await this.conn.models.FeedSubscription.findOne({
        platform,
        account,
        channel_id: channelId,
      })
        .lean<StoredFeedSubscription | null>()
        .exec();
      return ok(doc === null ? undefined : normalize(doc));
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoFeedSubscriptionRepo.find',
          input: { platform, account, channelId },
        }),
      );
    }
  }

  public async upsert(
    input: FeedSubscriptionUpsertInput,
  ): Promise<Result<FeedSubscriptionUpsertResult, DatabaseError>> {
    const { platform, account, channel_id } = input;
    try {
      return await this.runUpsert(input);
    } catch (rawErr: unknown) {
      const failure = databaseErrorFrom(rawErr, {
        operation: 'MongoFeedSubscriptionRepo.upsert',
        input: { platform, account, channel_id },
      });
      if (failure.code !== 'DATABASE_DUPLICATE_KEY') return err(failure);
      // Lost an insert race against a concurrent subscribe. The winner's
      // document now exists, so the same call succeeds as a plain update
      // this time. One retry only: a second duplicate-key would mean the
      // conflict is not the race this handles.
      try {
        const retried = await this.runUpsert(input);
        // The insert already happened, on the other caller's behalf.
        return retried.ok ? ok({ doc: retried.value.doc, created: false }) : retried;
      } catch (retryErr: unknown) {
        return err(
          databaseErrorFrom(retryErr, {
            operation: 'MongoFeedSubscriptionRepo.upsert.retry',
            input: { platform, account, channel_id },
          }),
        );
      }
    }
  }

  /**
   * One `findOneAndUpdate` attempt. Split out so the duplicate-key
   * retry replays exactly the same write rather than a paraphrase of it.
   */
  private async runUpsert(
    input: FeedSubscriptionUpsertInput,
  ): Promise<Result<FeedSubscriptionUpsertResult, DatabaseError>> {
    const { platform, account, channel_id, created_by, filter } = input;
    const res = await this.conn.models.FeedSubscription.findOneAndUpdate(
      { platform, account, channel_id },
      {
        $set: { filter },
        $setOnInsert: {
          platform,
          account,
          channel_id,
          created_by,
          created_at: Date.now(),
          ...(input.last_seen_id !== undefined ? { last_seen_id: input.last_seen_id } : {}),
          ...(input.last_seen_timestamp !== undefined
            ? { last_seen_timestamp: input.last_seen_timestamp }
            : {}),
        },
      },
      { upsert: true, new: true, includeResultMetadata: true, lean: true },
    ).exec();

    if (res.value === null) {
      // `upsert: true` with `new: true` always yields a document;
      // a null here means the driver contract was violated, which
      // belongs on the Err rail rather than in a non-null assertion.
      return err(
        databaseErrorFrom(new Error('findOneAndUpdate returned no document for an upsert'), {
          operation: 'MongoFeedSubscriptionRepo.upsert',
          input: { platform, account, channel_id },
        }),
      );
    }

    return ok({
      // `upserted` carries the new `_id` and is present only when the
      // upsert inserted. Deriving `created` from that positive signal
      // means absent metadata reports "updated" rather than claiming
      // a creation that may not have happened.
      doc: normalize(res.value),
      created: res.lastErrorObject?.upserted !== undefined,
    });
  }

  public async deleteWhere(
    where: FeedSubscriptionDeleteWhere,
  ): Promise<Result<readonly FeedSubscriptionDoc[], DatabaseError>> {
    const query = buildDeleteQuery(where);
    try {
      const doomed = await this.conn.models.FeedSubscription.find(query)
        .lean<StoredFeedSubscription[]>()
        .exec();
      if (doomed.length === 0) return ok([]);
      await this.conn.models.FeedSubscription.deleteMany(query).exec();
      return ok(doomed.map(normalize));
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoFeedSubscriptionRepo.deleteWhere',
          // Flattened rather than the raw query: the log reads better
          // with a list of handles than with a nested `$in` operator.
          input: { channelId: where.channelId, platform: where.platform, accounts: where.accounts },
        }),
      );
    }
  }

  public async advanceCursor(
    id: Types.ObjectId,
    lastSeenId: string,
    lastSeenTimestamp: number,
  ): Promise<Result<void, DatabaseError>> {
    try {
      await this.conn.models.FeedSubscription.updateOne(
        { _id: id },
        { $set: { last_seen_id: lastSeenId, last_seen_timestamp: lastSeenTimestamp } },
      ).exec();
      return ok(undefined);
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoFeedSubscriptionRepo.advanceCursor',
          input: { id: id.toString(), lastSeenId },
        }),
      );
    }
  }
}
