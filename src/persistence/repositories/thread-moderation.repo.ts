import type { DatabaseError } from '../../core/errors/external-service-error';
import { err, ok, type Result } from '../../core/result';
import type { GuildConnection } from '../../infra/mongo/connection-manager';
import { databaseErrorFrom } from '../error-translator';

export interface ThreadClaim {
  readonly id: string;
  readonly applicant_id: string;
  readonly owner_id: string;
  readonly reason: string;
  readonly requested_at: number;
  readonly expires_at: number;
  readonly status: 'pending' | 'approved' | 'rejected' | 'delivery_failed';
  readonly notices: readonly { admin_id: string; channel_id: string; message_id: string }[];
  readonly reviewed_by?: string;
  readonly reviewed_at?: number;
  readonly delivery_completed_at?: number;
}

export interface ThreadModerationRepo {
  recordMessageSource(
    botId: string,
    threadId: string,
    messageId: string,
    userId: string,
  ): Promise<Result<void, DatabaseError>>;
  findMessageSource(
    botId: string,
    threadId: string,
    messageId: string,
  ): Promise<Result<string | undefined, DatabaseError>>;
  isManager(
    botId: string,
    threadId: string,
    userId: string,
  ): Promise<Result<boolean, DatabaseError>>;
  listManagers(botId: string, threadId: string): Promise<Result<readonly string[], DatabaseError>>;
  setManager(
    botId: string,
    threadId: string,
    userId: string,
    actorId: string,
    granted: boolean,
    now: number,
  ): Promise<Result<void, DatabaseError>>;
  createClaim(
    botId: string,
    threadId: string,
    claim: ThreadClaim,
  ): Promise<Result<'created' | 'duplicate' | 'cooldown', DatabaseError>>;
  findClaim(
    botId: string,
    threadId: string,
    claimId: string,
  ): Promise<Result<ThreadClaim | undefined, DatabaseError>>;
  bindClaimNotices(
    botId: string,
    threadId: string,
    claimId: string,
    notices: ThreadClaim['notices'],
  ): Promise<Result<boolean, DatabaseError>>;
  completeClaimDelivery(
    botId: string,
    threadId: string,
    claimId: string,
    now: number,
  ): Promise<Result<boolean, DatabaseError>>;
  failClaimDelivery(
    botId: string,
    threadId: string,
    claimId: string,
  ): Promise<Result<boolean, DatabaseError>>;
  decideClaim(
    botId: string,
    threadId: string,
    claimId: string,
    reviewerId: string,
    channelId: string,
    messageId: string,
    approved: boolean,
    now: number,
  ): Promise<Result<boolean, DatabaseError>>;
  listBlocked(botId: string, threadId: string): Promise<Result<readonly string[], DatabaseError>>;
  isBlocked(
    botId: string,
    threadId: string,
    userId: string,
  ): Promise<Result<boolean, DatabaseError>>;
  /** Atomically add or remove all users, preserving concurrent changes to other users. */
  setBlocked(
    botId: string,
    threadId: string,
    userIds: readonly string[],
    blocked: boolean,
    managerActorId?: string,
  ): Promise<Result<void, DatabaseError>>;
}

export class MongoThreadModerationRepo implements ThreadModerationRepo {
  constructor(private readonly conn: GuildConnection) {}

  public async listBlocked(
    botId: string,
    threadId: string,
  ): Promise<Result<readonly string[], DatabaseError>> {
    try {
      const doc = await this.conn.models.ThreadModeration.findOne({
        bot_id: botId,
        thread_id: threadId,
      })
        .select({ blocked_user_ids: 1, _id: 0 })
        .lean()
        .exec();
      return ok(doc?.blocked_user_ids ?? []);
    } catch (raw: unknown) {
      return err(
        databaseErrorFrom(raw, {
          operation: 'MongoThreadModerationRepo.listBlocked',
          input: { botId, threadId },
        }),
      );
    }
  }

  public async isBlocked(
    botId: string,
    threadId: string,
    userId: string,
  ): Promise<Result<boolean, DatabaseError>> {
    try {
      const match = await this.conn.models.ThreadModeration.exists({
        bot_id: botId,
        thread_id: threadId,
        blocked_user_ids: userId,
        manager_ids: { $ne: userId },
      }).exec();
      return ok(match !== null);
    } catch (raw: unknown) {
      return err(
        databaseErrorFrom(raw, {
          operation: 'MongoThreadModerationRepo.isBlocked',
          input: { botId, threadId, userId },
        }),
      );
    }
  }

  public async setBlocked(
    botId: string,
    threadId: string,
    userIds: readonly string[],
    blocked: boolean,
    managerActorId?: string,
  ): Promise<Result<void, DatabaseError>> {
    if (userIds.length === 0) return ok(undefined);
    const filter = {
      bot_id: botId,
      thread_id: threadId,
      ...(managerActorId !== undefined
        ? {
            $and: [
              { manager_ids: managerActorId },
              ...(blocked ? [{ manager_ids: { $nin: [...userIds] } }] : []),
            ],
          }
        : blocked
          ? { manager_ids: { $nin: [...userIds] } }
          : {}),
    };
    const update = blocked
      ? { $addToSet: { blocked_user_ids: { $each: [...userIds] } } }
      : { $pull: { blocked_user_ids: { $in: [...userIds] } } };
    const write = async (upsert: boolean): Promise<void> => {
      const result = await this.conn.models.ThreadModeration.updateOne(filter, update, {
        upsert,
        runValidators: true,
      }).exec();
      if (
        (blocked || managerActorId !== undefined) &&
        result.matchedCount === 0 &&
        result.upsertedCount === 0
      ) {
        throw new Error('Thread manager authorization or target protection changed');
      }
    };
    try {
      await write(blocked && managerActorId === undefined);
      return ok(undefined);
    } catch (raw: unknown) {
      const failure = databaseErrorFrom(raw, {
        operation: 'MongoThreadModerationRepo.setBlocked',
        input: { botId, threadId, blocked },
      });
      if (!blocked || failure.code !== 'DATABASE_DUPLICATE_KEY') return err(failure);
      // Concurrent first bans can race to insert. Documents are retained
      // when unblocked, so the winner is available for a non-upsert retry.
      try {
        await write(false);
        return ok(undefined);
      } catch (retryError: unknown) {
        return err(
          databaseErrorFrom(retryError, {
            operation: 'MongoThreadModerationRepo.setBlocked.retry',
            input: { botId, threadId, blocked },
          }),
        );
      }
    }
  }

  private async execute<T>(
    operation: string,
    task: () => Promise<T>,
  ): Promise<Result<T, DatabaseError>> {
    try {
      return ok(await task());
    } catch (raw: unknown) {
      return err(databaseErrorFrom(raw, { operation: `MongoThreadModerationRepo.${operation}` }));
    }
  }

  private async ensureThread(botId: string, threadId: string): Promise<void> {
    try {
      await this.conn.models.ThreadModeration.updateOne(
        { bot_id: botId, thread_id: threadId },
        { $setOnInsert: { bot_id: botId, thread_id: threadId } },
        { upsert: true, runValidators: true },
      ).exec();
    } catch (raw: unknown) {
      // The unique key's winner created the document; subsequent writes use CAS.
      if (
        databaseErrorFrom(raw, { operation: 'MongoThreadModerationRepo.ensureThread' }).code !==
        'DATABASE_DUPLICATE_KEY'
      )
        throw raw;
    }
  }

  public async isManager(
    botId: string,
    threadId: string,
    userId: string,
  ): Promise<Result<boolean, DatabaseError>> {
    return this.execute(
      'isManager',
      async () =>
        (await this.conn.models.ThreadModeration.exists({
          bot_id: botId,
          thread_id: threadId,
          manager_ids: userId,
        }).exec()) !== null,
    );
  }

  public async listManagers(
    botId: string,
    threadId: string,
  ): Promise<Result<readonly string[], DatabaseError>> {
    return this.execute('listManagers', async () => {
      const doc = await this.conn.models.ThreadModeration.findOne({
        bot_id: botId,
        thread_id: threadId,
      })
        .select({ manager_ids: 1 })
        .lean()
        .exec();
      return doc?.manager_ids ?? [];
    });
  }

  public async setManager(
    botId: string,
    threadId: string,
    userId: string,
    actorId: string,
    granted: boolean,
    now: number,
  ): Promise<Result<void, DatabaseError>> {
    return this.execute('setManager', async () => {
      await this.ensureThread(botId, threadId);
      if (!granted) {
        // Older restriction documents predate claims; array filters require the path.
        await this.conn.models.ThreadModeration.updateOne(
          { bot_id: botId, thread_id: threadId, claims: { $exists: false } },
          { $set: { claims: [] } },
          { runValidators: true },
        ).exec();
      }
      await this.conn.models.ThreadModeration.updateOne(
        { bot_id: botId, thread_id: threadId },
        {
          ...(granted
            ? { $addToSet: { manager_ids: userId }, $pull: { blocked_user_ids: userId } }
            : {
                $pull: { manager_ids: userId },
                $set: {
                  'claims.$[pending].status': 'rejected',
                  'claims.$[pending].reviewed_by': actorId,
                  'claims.$[pending].reviewed_at': now,
                },
              }),
          $push: {
            management_log: {
              actor_id: actorId,
              user_id: userId,
              action: granted ? 'grant' : 'revoke',
              at: now,
            },
          },
        },
        {
          runValidators: true,
          ...(!granted
            ? { arrayFilters: [{ 'pending.applicant_id': userId, 'pending.status': 'pending' }] }
            : {}),
        },
      ).exec();
    });
  }

  public async createClaim(
    botId: string,
    threadId: string,
    claim: ThreadClaim,
  ): Promise<Result<'created' | 'duplicate' | 'cooldown', DatabaseError>> {
    return this.execute('createClaim', async () => {
      if (
        claim.status !== 'pending' ||
        claim.notices.length !== 0 ||
        claim.delivery_completed_at !== undefined
      )
        throw new Error('New claims must be pending without notices');
      await this.ensureThread(botId, threadId);
      // Interrupted deliveries have a short lease so applicants can recover after a restart.
      const abandoned = {
        applicant_id: claim.applicant_id,
        status: 'pending',
        requested_at: { $lte: claim.requested_at - 5 * 60_000 },
        delivery_completed_at: null,
      };
      await this.conn.models.ThreadModeration.updateOne(
        { bot_id: botId, thread_id: threadId, claims: { $elemMatch: abandoned } },
        { $set: { 'claims.$[abandoned].status': 'delivery_failed' } },
        {
          runValidators: true,
          arrayFilters: [
            {
              'abandoned.applicant_id': abandoned.applicant_id,
              'abandoned.status': abandoned.status,
              'abandoned.requested_at': abandoned.requested_at,
              'abandoned.delivery_completed_at': null,
            },
          ],
        },
      ).exec();
      const pending = {
        applicant_id: claim.applicant_id,
        status: 'pending',
        expires_at: { $gt: claim.requested_at },
      };
      const result = await this.conn.models.ThreadModeration.updateOne(
        {
          bot_id: botId,
          thread_id: threadId,
          $nor: [
            { claims: { $elemMatch: pending } },
            {
              claims: {
                $elemMatch: {
                  applicant_id: claim.applicant_id,
                  requested_at: { $gt: claim.requested_at - 60_000 },
                },
              },
            },
            { 'claims.id': claim.id },
          ],
        },
        { $push: { claims: claim } },
        { runValidators: true },
      ).exec();
      if (result.modifiedCount > 0) return 'created';
      const duplicate = await this.conn.models.ThreadModeration.exists({
        bot_id: botId,
        thread_id: threadId,
        $or: [{ claims: { $elemMatch: pending } }, { 'claims.id': claim.id }],
      }).exec();
      return duplicate ? 'duplicate' : 'cooldown';
    });
  }

  public async findClaim(
    botId: string,
    threadId: string,
    claimId: string,
  ): Promise<Result<ThreadClaim | undefined, DatabaseError>> {
    return this.execute('findClaim', async () => {
      const doc = await this.conn.models.ThreadModeration.findOne({
        bot_id: botId,
        thread_id: threadId,
        'claims.id': claimId,
      })
        .select({ claims: { $elemMatch: { id: claimId } } })
        .lean()
        .exec();
      const claim = doc?.claims[0];
      if (!claim) return undefined;
      return {
        id: claim.id,
        applicant_id: claim.applicant_id,
        owner_id: claim.owner_id,
        reason: claim.reason,
        requested_at: claim.requested_at,
        expires_at: claim.expires_at,
        status: claim.status,
        notices: claim.notices,
        ...(typeof claim.reviewed_by === 'string' ? { reviewed_by: claim.reviewed_by } : {}),
        ...(typeof claim.reviewed_at === 'number' ? { reviewed_at: claim.reviewed_at } : {}),
        ...(typeof claim.delivery_completed_at === 'number'
          ? { delivery_completed_at: claim.delivery_completed_at }
          : {}),
      };
    });
  }

  public async bindClaimNotices(
    botId: string,
    threadId: string,
    claimId: string,
    notices: ThreadClaim['notices'],
  ): Promise<Result<boolean, DatabaseError>> {
    return this.execute('bindClaimNotices', async () => {
      if (notices.length === 0) return false;
      const result = await this.conn.models.ThreadModeration.updateOne(
        {
          bot_id: botId,
          thread_id: threadId,
          claims: { $elemMatch: { id: claimId, status: 'pending', notices: { $size: 0 } } },
        },
        { $set: { 'claims.$.notices': notices } },
        { runValidators: true },
      ).exec();
      return result.modifiedCount > 0;
    });
  }

  public async completeClaimDelivery(
    botId: string,
    threadId: string,
    claimId: string,
    now: number,
  ): Promise<Result<boolean, DatabaseError>> {
    return this.execute('completeClaimDelivery', async () => {
      if (!Number.isFinite(now) || now <= 0) return false;
      const result = await this.conn.models.ThreadModeration.updateOne(
        {
          bot_id: botId,
          thread_id: threadId,
          claims: {
            $elemMatch: {
              id: claimId,
              status: 'pending',
              'notices.0': { $exists: true },
              delivery_completed_at: null,
              requested_at: { $gt: now - 5 * 60_000 },
              expires_at: { $gt: now },
            },
          },
        },
        { $set: { 'claims.$.delivery_completed_at': now } },
        { runValidators: true },
      ).exec();
      return result.modifiedCount > 0;
    });
  }

  public async failClaimDelivery(
    botId: string,
    threadId: string,
    claimId: string,
  ): Promise<Result<boolean, DatabaseError>> {
    return this.execute('failClaimDelivery', async () => {
      const result = await this.conn.models.ThreadModeration.updateOne(
        {
          bot_id: botId,
          thread_id: threadId,
          claims: { $elemMatch: { id: claimId, status: 'pending' } },
        },
        { $set: { 'claims.$.status': 'delivery_failed' } },
        { runValidators: true },
      ).exec();
      return result.modifiedCount > 0;
    });
  }

  public async decideClaim(
    botId: string,
    threadId: string,
    claimId: string,
    reviewerId: string,
    channelId: string,
    messageId: string,
    approved: boolean,
    now: number,
  ): Promise<Result<boolean, DatabaseError>> {
    return this.execute('decideClaim', async () => {
      const doc = await this.conn.models.ThreadModeration.findOne({
        bot_id: botId,
        thread_id: threadId,
        'claims.id': claimId,
      })
        .select({ claims: { $elemMatch: { id: claimId } } })
        .lean()
        .exec();
      const claim = doc?.claims[0];
      if (!claim) return false;
      const result = await this.conn.models.ThreadModeration.updateOne(
        {
          bot_id: botId,
          thread_id: threadId,
          claims: {
            $elemMatch: {
              id: claimId,
              status: 'pending',
              expires_at: { $gt: now },
              delivery_completed_at: { $type: 'number', $gt: 0 },
              notices: {
                $elemMatch: { admin_id: reviewerId, channel_id: channelId, message_id: messageId },
              },
            },
          },
        },
        {
          $set: {
            'claims.$.status': approved ? 'approved' : 'rejected',
            'claims.$.reviewed_by': reviewerId,
            'claims.$.reviewed_at': now,
          },
          ...(approved
            ? {
                $addToSet: { manager_ids: claim.applicant_id },
                $pull: { blocked_user_ids: claim.applicant_id },
              }
            : {}),
          $push: {
            management_log: {
              actor_id: reviewerId,
              user_id: claim.applicant_id,
              action: approved ? 'approve' : 'reject',
              at: now,
              claim_id: claimId,
            },
          },
        },
        { runValidators: true },
      ).exec();
      return result.modifiedCount > 0;
    });
  }

  public async recordMessageSource(
    botId: string,
    threadId: string,
    messageId: string,
    userId: string,
  ): Promise<Result<void, DatabaseError>> {
    return this.execute('recordMessageSource', async () => {
      const key = { bot_id: botId, thread_id: threadId, message_id: messageId };
      try {
        await this.conn.models.ThreadMessageSource.updateOne(
          { ...key, user_id: userId },
          {
            $setOnInsert: {
              ...key,
              user_id: userId,
              expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            },
          },
          { upsert: true, runValidators: true },
        ).exec();
      } catch (raw: unknown) {
        if (
          databaseErrorFrom(raw, { operation: 'MongoThreadModerationRepo.recordMessageSource' })
            .code !== 'DATABASE_DUPLICATE_KEY'
        )
          throw raw;
        // A concurrent first insert may win; attribution is immutable even after expiry.
        const stored = await this.conn.models.ThreadMessageSource.findOne(key)
          .select({ user_id: 1 })
          .lean()
          .exec();
        if (stored?.user_id !== userId)
          throw new Error('Message source attribution cannot be overwritten');
      }
    });
  }

  public async findMessageSource(
    botId: string,
    threadId: string,
    messageId: string,
  ): Promise<Result<string | undefined, DatabaseError>> {
    return this.execute('findMessageSource', async () => {
      const doc = await this.conn.models.ThreadMessageSource.findOne({
        bot_id: botId,
        thread_id: threadId,
        message_id: messageId,
        expires_at: { $gt: new Date() },
      })
        .select({ user_id: 1 })
        .lean()
        .exec();
      return doc?.user_id;
    });
  }
}
