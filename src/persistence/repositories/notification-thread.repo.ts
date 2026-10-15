/**
 * `NotificationThreadRepo` — where each relayed notification thread's
 * Discord message lives, in the route guild's database.
 */
import type { DatabaseError } from '../../core/errors/external-service-error';
import { err, ok, type Result } from '../../core/result';
import type { GuildConnection } from '../connection';
import { databaseErrorFrom } from '../error-translator';

/** Identifies one thread: the relaying bot, the configured route and the caller's key. */
export interface NotificationThreadId {
  readonly botId: string;
  readonly route: string;
  readonly threadKey: string;
}

export interface NotificationThreadMessage {
  readonly channelId: string;
  readonly messageId: string;
}

export interface NotificationThreadRepo {
  find(
    id: NotificationThreadId,
  ): Promise<Result<NotificationThreadMessage | undefined, DatabaseError>>;
  /** Insert or replace the thread's message and restart its expiry from `updatedAt`. */
  save(
    id: NotificationThreadId,
    message: NotificationThreadMessage,
    updatedAt: Date,
  ): Promise<Result<void, DatabaseError>>;
}

const filterOf = (id: NotificationThreadId) => ({
  bot_id: id.botId,
  route: id.route,
  thread_key: id.threadKey,
});

export class MongoNotificationThreadRepo implements NotificationThreadRepo {
  constructor(private readonly conn: GuildConnection) {}

  private fail(operation: string, rawErr: unknown): DatabaseError {
    return databaseErrorFrom(rawErr, { operation: `MongoNotificationThreadRepo.${operation}` });
  }

  public async find(
    id: NotificationThreadId,
  ): Promise<Result<NotificationThreadMessage | undefined, DatabaseError>> {
    try {
      const doc = await this.conn.models.NotificationThread.findOne(filterOf(id))
        .lean<{ channel_id: string; message_id: string }>()
        .exec();
      return ok(
        doc === null ? undefined : { channelId: doc.channel_id, messageId: doc.message_id },
      );
    } catch (rawErr: unknown) {
      return err(this.fail('find', rawErr));
    }
  }

  public async save(
    id: NotificationThreadId,
    message: NotificationThreadMessage,
    updatedAt: Date,
  ): Promise<Result<void, DatabaseError>> {
    try {
      await this.conn.models.NotificationThread.updateOne(
        filterOf(id),
        {
          $set: {
            channel_id: message.channelId,
            message_id: message.messageId,
            updated_at: updatedAt,
          },
        },
        { upsert: true },
      ).exec();
      return ok(undefined);
    } catch (rawErr: unknown) {
      return err(this.fail('save', rawErr));
    }
  }
}
