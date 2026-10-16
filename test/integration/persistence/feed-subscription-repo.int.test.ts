import { type Connection, Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { DatabaseError } from '../../../src/core/errors';
import { asGuildId } from '../../../src/core/ids';
import { isErr, isOk, unwrap } from '../../../src/core/result';
import {
  StaticConnectionManager,
  type GuildConnection,
} from '../../../src/infra/mongo/connection-manager';
import {
  MongoFeedSubscriptionRepo,
  type FeedSubscriptionUpsertInput,
} from '../../../src/persistence/repositories/feed-subscription.repo';
import { withClosedConnection, withFreshConnection } from '../helpers/mongo';

const guildId = asGuildId('999999999999999999');

/** Collection backing the `FeedSubscription` model, per mongoose pluralisation. */
const COLLECTION = 'feedsubscriptions';

const buildRepo = async (m: StaticConnectionManager): Promise<MongoFeedSubscriptionRepo> =>
  new MongoFeedSubscriptionRepo(await m.getConnection(guildId));

const openGuild = (connection: Connection): Promise<GuildConnection> =>
  new StaticConnectionManager(connection).getConnection(guildId);

/**
 * A real 64-bit X post id. It exceeds `Number.MAX_SAFE_INTEGER`, so these
 * tests double as proof that the String column round-trips it intact —
 * a Number column would corrupt it and silently break de-duplication.
 */
const BIG_ID = '2092744659667673582';

const subscription = (
  overrides: Partial<FeedSubscriptionUpsertInput> = {},
): FeedSubscriptionUpsertInput => ({
  platform: 'x',
  account: 'acct',
  channel_id: 'channel-1',
  created_by: 'user-1',
  filter: { media: 'media_only' },
  ...overrides,
});

const buildRepoOnClosedConnection = (): Promise<MongoFeedSubscriptionRepo> =>
  withClosedConnection(
    async (connection) => new MongoFeedSubscriptionRepo(await openGuild(connection)),
  );

describe('MongoFeedSubscriptionRepo — lookup (integration)', () => {
  it('find returns ok(undefined) when the channel has no such subscription', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      expect(unwrap(await repo.find('x', 'nobody', 'channel-1'))).toBeUndefined();
    });
  });

  it('list returns an empty list for a fresh guild', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      expect(unwrap(await repo.list())).toEqual([]);
    });
  });

  it('listByChannel returns only that channel, list returns every subscription', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      unwrap(await repo.upsert(subscription({ account: 'alpha', channel_id: 'channel-1' })));
      unwrap(await repo.upsert(subscription({ account: 'beta', channel_id: 'channel-1' })));
      unwrap(await repo.upsert(subscription({ account: 'gamma', channel_id: 'channel-2' })));

      const inChannel = unwrap(await repo.listByChannel('channel-1'));
      expect(inChannel.map((d) => d.account)).toEqual(['alpha', 'beta']);
      expect(unwrap(await repo.list())).toHaveLength(3);
    });
  });

  it('listByChannel returns ok([]) for a channel with no subscriptions', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      unwrap(await repo.upsert(subscription()));
      expect(unwrap(await repo.listByChannel('channel-elsewhere'))).toEqual([]);
    });
  });
});

/**
 * A `lean` read bypasses mongoose's defaults and its `enum` validation,
 * so the repository normalises on the way out. These cases write the
 * raw shapes mongoose would never produce and prove every read path
 * repairs them — `list` in particular is the poll pass's input, where a
 * missing `filter.media` would silently change what gets forwarded.
 */
describe('MongoFeedSubscriptionRepo — read normalisation (integration)', () => {
  const insertRaw = async (guild: GuildConnection, doc: Record<string, unknown>): Promise<void> => {
    await guild.models.FeedSubscription.collection.insertOne({
      platform: 'x',
      account: 'legacy',
      channel_id: 'channel-1',
      created_by: 'user-1',
      created_at: 1,
      ...doc,
    });
  };

  it('supplies the default media filter for a document stored without one', async () => {
    await withFreshConnection(async (connection) => {
      const guild = await openGuild(connection);
      const repo = new MongoFeedSubscriptionRepo(guild);
      await insertRaw(guild, {});

      expect(unwrap(await repo.find('x', 'legacy', 'channel-1'))?.filter.media).toBe('media_only');
      expect(unwrap(await repo.list())[0]?.filter.media).toBe('media_only');
      expect(unwrap(await repo.listByChannel('channel-1'))[0]?.filter.media).toBe('media_only');
    });
  });

  it('replaces a stored media filter this build does not know', async () => {
    await withFreshConnection(async (connection) => {
      const guild = await openGuild(connection);
      const repo = new MongoFeedSubscriptionRepo(guild);
      await insertRaw(guild, { filter: { media: 'images_only' } });

      expect(unwrap(await repo.find('x', 'legacy', 'channel-1'))?.filter.media).toBe('media_only');
      expect(unwrap(await repo.list())[0]?.filter.media).toBe('media_only');
    });
  });

  it('collapses a null cursor and a null keyword to undefined', async () => {
    await withFreshConnection(async (connection) => {
      const guild = await openGuild(connection);
      const repo = new MongoFeedSubscriptionRepo(guild);
      await insertRaw(guild, {
        filter: { media: 'any', keyword: null },
        last_seen_id: null,
        last_seen_timestamp: null,
      });

      const found = unwrap(await repo.find('x', 'legacy', 'channel-1'));
      expect(found?.filter.media).toBe('any');
      expect(found?.filter.keyword).toBeUndefined();
      expect(found?.last_seen_id).toBeUndefined();
      expect(found?.last_seen_timestamp).toBeUndefined();
    });
  });

  it('normalises the documents deleteWhere reports as deleted', async () => {
    await withFreshConnection(async (connection) => {
      const guild = await openGuild(connection);
      const repo = new MongoFeedSubscriptionRepo(guild);
      await insertRaw(guild, {});

      const deleted = unwrap(await repo.deleteWhere({ channelId: 'channel-1' }));
      expect(deleted[0]?.filter.media).toBe('media_only');
    });
  });
});

describe('MongoFeedSubscriptionRepo — upsert (integration)', () => {
  it('creates the subscription with its filter, seeded cursor and creation time', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      const before = Date.now();
      const result = unwrap(
        await repo.upsert(
          subscription({
            filter: { media: 'photo_only', keyword: 'launch' },
            last_seen_id: BIG_ID,
            last_seen_timestamp: 1_787_784_182,
          }),
        ),
      );
      const after = Date.now();

      expect(result.created).toBe(true);
      expect(result.doc.filter.media).toBe('photo_only');
      expect(result.doc.filter.keyword).toBe('launch');
      expect(result.doc.last_seen_id).toBe(BIG_ID);
      expect(result.doc.last_seen_timestamp).toBe(1_787_784_182);
      expect(result.doc.created_by).toBe('user-1');
      // `created_at` is unix milliseconds; `findOneAndUpdate` runs no
      // validators, so only this assertion keeps the field written.
      expect(result.doc.created_at).toBeGreaterThanOrEqual(before);
      expect(result.doc.created_at).toBeLessThanOrEqual(after);
    });
  });

  it('round-trips a 64-bit post id without precision loss', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      unwrap(await repo.upsert(subscription({ last_seen_id: BIG_ID, last_seen_timestamp: 1 })));

      const found = unwrap(await repo.find('x', 'acct', 'channel-1'));
      expect(found?.last_seen_id).toBe(BIG_ID);
      expect(BigInt(found?.last_seen_id ?? '0')).toBe(BigInt(BIG_ID));
    });
  });

  it('re-subscribing updates the filter and preserves cursor, creator and creation time', async () => {
    await withFreshConnection(async (connection) => {
      const guild = await openGuild(connection);
      const repo = new MongoFeedSubscriptionRepo(guild);
      unwrap(
        await repo.upsert(
          subscription({ last_seen_id: BIG_ID, last_seen_timestamp: 1_787_784_182 }),
        ),
      );
      // Pin `created_at` to a sentinel so its preservation is asserted
      // deterministically rather than relying on millisecond timing.
      await guild.models.FeedSubscription.updateOne(
        { platform: 'x', account: 'acct', channel_id: 'channel-1' },
        { $set: { created_at: 1 } },
      ).exec();

      const second = unwrap(
        await repo.upsert(
          subscription({
            created_by: 'user-2',
            filter: { media: 'any', keyword: 'patch' },
            last_seen_id: '1',
            last_seen_timestamp: 2,
          }),
        ),
      );

      expect(second.created).toBe(false);
      expect(second.doc.filter.media).toBe('any');
      expect(second.doc.filter.keyword).toBe('patch');
      expect(second.doc.last_seen_id).toBe(BIG_ID);
      expect(second.doc.last_seen_timestamp).toBe(1_787_784_182);
      expect(second.doc.created_by).toBe('user-1');
      expect(second.doc.created_at).toBe(1);

      const count = await connection
        .collection(COLLECTION)
        .countDocuments({ platform: 'x', account: 'acct', channel_id: 'channel-1' });
      expect(count).toBe(1);
    });
  });

  it('replaces the filter wholesale, dropping a keyword the new filter omits', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      unwrap(await repo.upsert(subscription({ filter: { media: 'any', keyword: 'launch' } })));

      const second = unwrap(await repo.upsert(subscription({ filter: { media: 'any' } })));
      expect(second.doc.filter.keyword).toBeUndefined();
    });
  });

  it('keeps one subscription per channel for the same account, each with its own cursor', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      unwrap(
        await repo.upsert(
          subscription({ channel_id: 'channel-1', last_seen_id: '100', last_seen_timestamp: 10 }),
        ),
      );
      unwrap(
        await repo.upsert(
          subscription({ channel_id: 'channel-2', last_seen_id: '200', last_seen_timestamp: 20 }),
        ),
      );

      expect(unwrap(await repo.find('x', 'acct', 'channel-1'))?.last_seen_id).toBe('100');
      expect(unwrap(await repo.find('x', 'acct', 'channel-2'))?.last_seen_id).toBe('200');
    });
  });

  it('keeps subscriptions on different platforms apart within one channel', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      unwrap(await repo.upsert(subscription({ platform: 'x', last_seen_id: '100' })));
      unwrap(await repo.upsert(subscription({ platform: 'fake', last_seen_id: '200' })));

      expect(unwrap(await repo.find('x', 'acct', 'channel-1'))?.last_seen_id).toBe('100');
      expect(unwrap(await repo.find('fake', 'acct', 'channel-1'))?.last_seen_id).toBe('200');
    });
  });

  it('enforces the unique (platform, account, channel_id) index', async () => {
    await withFreshConnection(async (connection) => {
      const guild = await openGuild(connection);
      const duplicate = {
        platform: 'x',
        account: 'acct',
        channel_id: 'channel-1',
        created_by: 'user-1',
        created_at: 1,
        filter: { media: 'media_only' as const },
      };

      // E11000 specifically: a generic rejection would also be produced
      // by a validation failure, which would not prove the index exists.
      await expect(
        guild.models.FeedSubscription.insertMany([duplicate, duplicate]),
      ).rejects.toThrow(/E11000/);
    });
  });

  it('reports an insert race as an update rather than a duplicate-key failure', async () => {
    await withFreshConnection(async (connection) => {
      const guild = await openGuild(connection);
      const repo = new MongoFeedSubscriptionRepo(guild);
      const input = subscription({ account: 'racer' });

      // Stand in for the losing side of a race: the document appears
      // between this caller's lookup and its insert, so the driver
      // answers E11000. The contract is "re-subscribing is an update",
      // so the user must never read "that already exists".
      const findOneAndUpdate = guild.models.FeedSubscription.findOneAndUpdate.bind(
        guild.models.FeedSubscription,
      );
      let attempts = 0;
      guild.models.FeedSubscription.findOneAndUpdate = ((...args: unknown[]) => {
        attempts += 1;
        if (attempts === 1) {
          return {
            exec: async () => {
              // Let the winner's document land first, then fail as the
              // unique index would have.
              await (findOneAndUpdate as never as typeof findOneAndUpdate)(
                ...(args as Parameters<typeof findOneAndUpdate>),
              ).exec();
              throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
            },
          };
        }
        return (findOneAndUpdate as never as typeof findOneAndUpdate)(
          ...(args as Parameters<typeof findOneAndUpdate>),
        );
      }) as typeof guild.models.FeedSubscription.findOneAndUpdate;

      const result = await repo.upsert(input);

      expect(isOk(result)).toBe(true);
      // The insert did happen — on the winner's behalf, not this call's.
      expect(unwrap(result).created).toBe(false);
      expect(unwrap(result).doc.account).toBe('racer');
      expect(attempts).toBe(2);
    });
  });

  it('surfaces a persistent duplicate-key failure instead of retrying forever', async () => {
    await withFreshConnection(async (connection) => {
      const guild = await openGuild(connection);
      const repo = new MongoFeedSubscriptionRepo(guild);

      guild.models.FeedSubscription.findOneAndUpdate = (() => ({
        exec: async () => {
          throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
        },
      })) as unknown as typeof guild.models.FeedSubscription.findOneAndUpdate;

      const result = await repo.upsert(subscription({ account: 'doomed' }));

      expect(isErr(result)).toBe(true);
      if (!isErr(result)) return;
      expect(result.error).toBeInstanceOf(DatabaseError);
      expect(result.error.code).toBe('DATABASE_DUPLICATE_KEY');
    });
  });
});

describe('MongoFeedSubscriptionRepo — deleteWhere (integration)', () => {
  const seedChannel = async (repo: MongoFeedSubscriptionRepo): Promise<void> => {
    unwrap(await repo.upsert(subscription({ platform: 'x', account: 'alpha' })));
    unwrap(await repo.upsert(subscription({ platform: 'fake', account: 'beta' })));
    unwrap(await repo.upsert(subscription({ account: 'gamma', channel_id: 'channel-2' })));
  };

  it('clears a whole channel and reports every deleted subscription in full', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      await seedChannel(repo);

      const deleted = unwrap(await repo.deleteWhere({ channelId: 'channel-1' }));
      expect(deleted.map((d) => d.account).sort()).toEqual(['alpha', 'beta']);
      // The unsubscribe reply renders platform, channel and filter per
      // row, so the whole document has to survive the round trip.
      const alpha = deleted.find((d) => d.account === 'alpha');
      expect(alpha?.platform).toBe('x');
      expect(alpha?.channel_id).toBe('channel-1');
      expect(alpha?.filter.media).toBe('media_only');
      expect(alpha?.created_by).toBe('user-1');

      expect(unwrap(await repo.listByChannel('channel-1'))).toEqual([]);
      expect(unwrap(await repo.listByChannel('channel-2'))).toHaveLength(1);
    });
  });

  it('narrows to one account when given one', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      await seedChannel(repo);

      const deleted = unwrap(
        await repo.deleteWhere({ channelId: 'channel-1', accounts: ['alpha'] }),
      );
      expect(deleted).toHaveLength(1);
      expect(deleted[0]?.account).toBe('alpha');
      expect(unwrap(await repo.listByChannel('channel-1')).map((d) => d.account)).toEqual(['beta']);
    });
  });

  it('removes every named account in one call, across platforms', async () => {
    // The `$in` scope one `/feed unsubscribe` invocation now builds.
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      await seedChannel(repo);
      unwrap(await repo.upsert(subscription({ account: 'delta' })));

      const deleted = unwrap(
        await repo.deleteWhere({ channelId: 'channel-1', accounts: ['alpha', 'beta'] }),
      );
      expect(deleted.map((d) => d.account).sort()).toEqual(['alpha', 'beta']);
      // Everything not named survives, in this channel and the others.
      expect(unwrap(await repo.listByChannel('channel-1')).map((d) => d.account)).toEqual([
        'delta',
      ]);
      expect(unwrap(await repo.listByChannel('channel-2'))).toHaveLength(1);
    });
  });

  it('ignores a named account that is not subscribed, without failing', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      await seedChannel(repo);

      const deleted = unwrap(
        await repo.deleteWhere({ channelId: 'channel-1', accounts: ['alpha', 'never-subscribed'] }),
      );
      expect(deleted.map((d) => d.account)).toEqual(['alpha']);
    });
  });

  it('combines an account list with a platform, intersecting the two', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      await seedChannel(repo);

      const deleted = unwrap(
        await repo.deleteWhere({
          channelId: 'channel-1',
          platform: 'fake',
          accounts: ['alpha', 'beta'],
        }),
      );
      // `alpha` is on `x`, so only `beta` matches both halves.
      expect(deleted.map((d) => d.account)).toEqual(['beta']);
    });
  });

  it('deletes nothing for an empty account list rather than clearing the channel', async () => {
    // The one case where "no narrowing" would be catastrophic: an empty
    // list names no account and must therefore match none.
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      await seedChannel(repo);

      expect(unwrap(await repo.deleteWhere({ channelId: 'channel-1', accounts: [] }))).toEqual([]);
      expect(unwrap(await repo.listByChannel('channel-1'))).toHaveLength(2);
    });
  });

  it('narrows to one platform when given one', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      await seedChannel(repo);

      const deleted = unwrap(await repo.deleteWhere({ channelId: 'channel-1', platform: 'fake' }));
      expect(deleted.map((d) => d.account)).toEqual(['beta']);
      expect(unwrap(await repo.listByChannel('channel-1')).map((d) => d.account)).toEqual([
        'alpha',
      ]);
    });
  });

  it('reports ok([]) when nothing matches rather than failing', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      await seedChannel(repo);

      expect(unwrap(await repo.deleteWhere({ channelId: 'channel-unknown' }))).toEqual([]);
      expect(
        unwrap(await repo.deleteWhere({ channelId: 'channel-1', accounts: ['not-subscribed'] })),
      ).toEqual([]);
      expect(unwrap(await repo.list())).toHaveLength(3);
    });
  });
});

describe('MongoFeedSubscriptionRepo — advanceCursor (integration)', () => {
  it('moves the cursor forward without disturbing the filter', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      const created = unwrap(
        await repo.upsert(
          subscription({
            filter: { media: 'video_only', keyword: 'launch' },
            last_seen_id: '100',
            last_seen_timestamp: 10,
          }),
        ),
      );

      unwrap(await repo.advanceCursor(created.doc._id, BIG_ID, 1_787_784_182));

      const found = unwrap(await repo.find('x', 'acct', 'channel-1'));
      expect(found?.last_seen_id).toBe(BIG_ID);
      expect(found?.last_seen_timestamp).toBe(1_787_784_182);
      expect(found?.filter.media).toBe('video_only');
      expect(found?.filter.keyword).toBe('launch');
    });
  });

  it('is a no-op, not a failure, when the subscription was unsubscribed mid-pass', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      // The poll pass holds a document that a concurrent
      // feed_unsubscribe has already deleted.
      expect(isOk(await repo.advanceCursor(new Types.ObjectId(), BIG_ID, 1))).toBe(true);
    });
  });

  it('reports a mongoose cast rejection on the Err rail instead of throwing', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      const created = unwrap(await repo.upsert(subscription()));

      // NaN is valid BSON; it is mongoose's Number caster that rejects it.
      const result = await repo.advanceCursor(created.doc._id, BIG_ID, Number.NaN);
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error).toBeInstanceOf(DatabaseError);
        expect(result.error.context.operation).toBe('MongoFeedSubscriptionRepo.advanceCursor');
      }
    });
  });
});

describe('MongoFeedSubscriptionRepo — driver failures (integration)', () => {
  it('list resolves to err(DatabaseError) when the connection is closed', async () => {
    const repo = await buildRepoOnClosedConnection();

    const result = await repo.list();
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(DatabaseError);
      expect(result.error.context.operation).toBe('MongoFeedSubscriptionRepo.list');
    }
  });

  it('deleteWhere resolves to err(DatabaseError) when the connection is closed', async () => {
    const repo = await buildRepoOnClosedConnection();

    const result = await repo.deleteWhere({ channelId: 'channel-1' });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(DatabaseError);
      expect(result.error.context.operation).toBe('MongoFeedSubscriptionRepo.deleteWhere');
    }
  });

  it('upsert resolves to err(DatabaseError) when the connection is closed', async () => {
    const repo = await buildRepoOnClosedConnection();

    const result = await repo.upsert(subscription());
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(DatabaseError);
      expect(result.error.context.operation).toBe('MongoFeedSubscriptionRepo.upsert');
    }
  });

  it('find resolves to err(DatabaseError) when the connection is closed', async () => {
    const repo = await buildRepoOnClosedConnection();

    const result = await repo.find('x', 'acct', 'channel-1');
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(DatabaseError);
      expect(result.error.context.operation).toBe('MongoFeedSubscriptionRepo.find');
    }
  });

  it('listByChannel resolves to err(DatabaseError) when the connection is closed', async () => {
    const repo = await buildRepoOnClosedConnection();

    const result = await repo.listByChannel('channel-1');
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(DatabaseError);
      expect(result.error.context.operation).toBe('MongoFeedSubscriptionRepo.listByChannel');
    }
  });
});
