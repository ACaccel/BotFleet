import { describe, expect, it } from 'vitest';
import { MongoArchiveContinuityRepo } from '../../../src/persistence/repositories/archive-continuity.repo';
import { ArchiveContinuityConflictError } from '../../../src/core/archive/errors';
import type { ArchiveGatewayContinuity } from '../../../src/core/archive/types';
import { withFreshConnection } from '../helpers/mongo';

const record: ArchiveGatewayContinuity = {
  bootId: 'boot',
  continuousSince: 100,
  confirmedAt: 200,
  fullRequired: false,
  gapVersion: 2,
  breakIndex: 3,
  breaks: [
    { index: 2, start: 50, channelId: '10' },
    { index: 3, start: 150, channelId: null },
  ],
};

describe('archive Gateway continuity store', () => {
  it('round-trips the record and writes only while this boot owns it', async () =>
    withFreshConnection(async (connection) => {
      const store = new MongoArchiveContinuityRepo(connection);
      expect(await store.read()).toBeNull();
      await store.begin(record);
      expect(await store.read()).toEqual(record);
      await store.write({ ...record, confirmedAt: 300 });
      expect(await store.read()).toMatchObject({ confirmedAt: 300 });
      await store.begin({ ...record, bootId: 'successor' });
      await expect(store.write({ ...record, confirmedAt: 400 })).rejects.toBeInstanceOf(
        ArchiveContinuityConflictError,
      );
      expect(await store.read()).toMatchObject({ bootId: 'successor', confirmedAt: 200 });
    }));

  it.each([
    { name: 'a missing field', change: { $unset: { breakIndex: 1 } } },
    { name: 'an unknown field', change: { $set: { rescanFrom: 1 } } },
    { name: 'a malformed break', change: { $set: { breaks: [{ index: 0, start: 1 }] } } },
    { name: 'a negative timestamp', change: { $set: { confirmedAt: -1 } } },
  ])('reads a record with $name as absent', async ({ change }) =>
    withFreshConnection(async (connection) => {
      const store = new MongoArchiveContinuityRepo(connection);
      await store.begin(record);
      await connection
        .collection('archive_gateway_continuity')
        .updateOne({ _id: 'current' as never }, change);
      expect(await store.read()).toBeNull();
    }),
  );
});
