import { assertTimeZone, type ArchiveChannelInfo } from '../../core/archive/stats';
import type { DatabaseError } from '../../core/errors/external-service-error';
import { err, ok, type Result } from '../../core/result';
import type { GuildConnection } from '../connection';
import { databaseErrorFrom } from '../error-translator';
import { assertWindow } from './archive-stats.report';
import { gayStatsPipeline } from './gay-stats.pipeline';
import type {
  GayArchiveMemberSummary,
  GayArchiveSummary,
  GayStatsQuery,
  GayStatsRepo,
} from './gay-stats.types';

const QUERY_BUDGET_MS = 500;
const CHANNEL_TIME_INDEX = { channelId: 1, createdTimestamp: 1 } as const;
interface MemberRow extends GayArchiveMemberSummary {
  readonly replyDays?: number;
  readonly mentionDays?: number;
}
interface Output extends Record<string, unknown> {
  readonly members: readonly MemberRow[];
  readonly shared: readonly { readonly days: number }[];
}

/** Optional entertainment statistics must not keep a command waiting on a large archive. */
export class MongoGayStatsRepo implements GayStatsRepo {
  public constructor(private readonly conn: GuildConnection) {}

  public async summarize(
    query: GayStatsQuery,
  ): Promise<Result<GayArchiveSummary | undefined, DatabaseError>> {
    assertWindow(query.window, 'MongoGayStatsRepo.summarize');
    assertTimeZone(query.timeZone);
    const userIds = [...new Set(query.userIds)].sort();
    if (userIds.length < 1 || userIds.length > 2 || userIds.some((id) => id.length === 0))
      throw new TypeError('Gay statistics require one or two nonempty user IDs.');
    if (query.channelIds.length === 0) return ok(undefined);
    const startedAt = performance.now();
    const run = async (hint: boolean): Promise<Output[]> => {
      const remaining = Math.floor(QUERY_BUDGET_MS - (performance.now() - startedAt));
      if (remaining <= 0) throw { code: 50, message: 'Gay statistics query budget exceeded.' };
      const db = this.conn.connection.db;
      if (db === undefined) throw new Error('Archive database is unavailable');
      // Bypass Mongoose buffering, which is outside the native client's timeout.
      return db
        .collection('messages')
        .aggregate<Output>(gayStatsPipeline(query, userIds), {
          maxTimeMS: remaining,
          timeoutMS: remaining,
          allowDiskUse: false,
          ...(hint ? { hint: { ...CHANNEL_TIME_INDEX } } : {}),
        })
        .toArray();
    };
    try {
      let output: Output | undefined;
      try {
        [output] = await run(true);
      } catch (cause: unknown) {
        // Reader startup cannot create indexes; old archives can still answer within the remaining budget.
        if (!missingHint(cause)) throw cause;
        [output] = await run(false);
      }
      if (output === undefined || output.members.length === 0) return ok(undefined);
      const members = output.members.map(({ userId, messages, activeDays, emojiRatio }) => ({
        userId,
        messages,
        activeDays,
        ...(emojiRatio === undefined ? {} : { emojiRatio }),
      }));
      const [a, b] = output.members;
      const pair =
        userIds.length === 2 && a !== undefined && b !== undefined
          ? {
              ...(a.replyDays === undefined ? {} : { repliesABDays: a.replyDays }),
              ...(b.replyDays === undefined ? {} : { repliesBADays: b.replyDays }),
              ...(a.mentionDays === undefined ? {} : { mentionsABDays: a.mentionDays }),
              ...(b.mentionDays === undefined ? {} : { mentionsBADays: b.mentionDays }),
              sharedChannelDays: output.shared[0]?.days ?? 0,
            }
          : undefined;
      return ok({ members, ...(pair === undefined ? {} : { pair }) });
    } catch (cause: unknown) {
      return err(databaseErrorFrom(cause, { operation: 'MongoGayStatsRepo.summarize' }));
    }
  }

  public async listChannels(): Promise<Result<readonly ArchiveChannelInfo[], DatabaseError>> {
    try {
      const db = this.conn.connection.db;
      if (db === undefined) throw new Error('Archive database is unavailable');
      return ok(
        await db
          .collection('archive_channels')
          .find<ArchiveChannelInfo>(
            {},
            {
              projection: {
                _id: 0,
                channelId: 1,
                name: 1,
                type: 1,
                parentId: 1,
                access: 1,
                everyoneCanView: 1,
              },
              maxTimeMS: QUERY_BUDGET_MS,
              timeoutMS: QUERY_BUDGET_MS,
            },
          )
          .toArray(),
      );
    } catch (cause: unknown) {
      return err(databaseErrorFrom(cause, { operation: 'MongoGayStatsRepo.listChannels' }));
    }
  }
}

const missingHint = (cause: unknown): boolean => {
  if (typeof cause !== 'object' || cause === null) return false;
  const error = cause as { readonly code?: unknown; readonly message?: unknown };
  return (
    error.code === 2 &&
    typeof error.message === 'string' &&
    /hint.*(?:index|indices)/i.test(error.message)
  );
};
