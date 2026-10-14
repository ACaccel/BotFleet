import { describe, expect, it } from 'vitest';

import { asGuildId } from '../../../src/core/ids';
import { unwrap } from '../../../src/core/result';
import { StaticConnectionManager } from '../../../src/infra/mongo/connection-manager';
import { MongoGayReadingRepo } from '../../../src/persistence/repositories/gay-reading.repo';
import type { GayReadingDoc } from '../../../src/persistence/schemas/gay-reading.schema';
import { withFreshConnection } from '../helpers/mongo';

const READING = { percent: 87, commentKey: 'replies:gay.single_high_1' };

describe('daily reading snapshots', () => {
  it('stores only scores, retains the first reading across readers and configures expiry', async () => {
    await withFreshConnection(async (connection) => {
      const guild = await new StaticConnectionManager(connection).getConnection(asGuildId('1'));
      await guild.models.GayReading.init();
      const repo = new MongoGayReadingRepo(guild);
      const expiresAt = new Date(Date.now() + 86_400_000);
      expect(unwrap(await repo.find('key'))).toBeUndefined();
      expect(unwrap(await repo.remember('key', READING, expiresAt))).toEqual(READING);
      const restarted = new MongoGayReadingRepo(guild);
      expect(
        unwrap(await restarted.remember('key', { ...READING, percent: 35 }, expiresAt)),
      ).toEqual(READING);
      expect(unwrap(await restarted.find('key'))).toEqual(READING);
      const stored = await connection
        .collection<GayReadingDoc>('gay_readings')
        .findOne({ _id: 'key' });
      expect(Object.keys(stored ?? {}).sort()).toEqual([
        '_id',
        'commentKey',
        'expiresAt',
        'percent',
      ]);
      expect(stored?.expiresAt).toEqual(expiresAt);
      const indexes = await connection.collection('gay_readings').indexes();
      expect(indexes).toContainEqual(
        expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
      );
    });
  });

  it('returns the same atomic winner to concurrent bot instances', async () => {
    await withFreshConnection(async (connection) => {
      const guild = await new StaticConnectionManager(connection).getConnection(asGuildId('1'));
      await guild.models.GayReading.init();
      const expiresAt = new Date(Date.now() + 86_400_000);
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          new MongoGayReadingRepo(guild).remember(
            'race',
            { ...READING, percent: index },
            expiresAt,
          ),
        ),
      );
      const first = results[0];
      if (first === undefined) throw new Error('Missing concurrent reading');
      const winner = unwrap(first);
      for (const result of results) expect(unwrap(result)).toEqual(winner);
      expect(await connection.collection('gay_readings').countDocuments()).toBe(1);
    });
  });

  it('rejects corrupt stored readings instead of publishing them', async () => {
    await withFreshConnection(async (connection) => {
      const guild = await new StaticConnectionManager(connection).getConnection(asGuildId('1'));
      await connection
        .collection<{ _id: string; percent: number; commentKey: string }>('gay_readings')
        .insertOne({ _id: 'corrupt', percent: 200, commentKey: '@everyone' });
      const result = await new MongoGayReadingRepo(guild).find('corrupt');
      expect(result.ok).toBe(false);
    });
  });
});
