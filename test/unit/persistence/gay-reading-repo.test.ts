import { describe, expect, it, vi } from 'vitest';

import type { GuildConnection } from '../../../src/persistence/connection';
import { MongoGayReadingRepo } from '../../../src/persistence/repositories/gay-reading.repo';

const READING = { percent: 70, commentKey: 'replies:gay.single_mid_1' };
const fixture = () => {
  const findOne = vi.fn().mockResolvedValue(READING);
  const findOneAndUpdate = vi.fn().mockResolvedValue(READING);
  const conn = {
    connection: { db: { collection: () => ({ findOne, findOneAndUpdate }) } },
  } as unknown as GuildConnection;
  return { repo: new MongoGayReadingRepo(conn), findOne, findOneAndUpdate };
};

describe('daily snapshot query boundaries', () => {
  it('sets native server and client limits for snapshot reads and atomic writes', async () => {
    const { repo, findOne, findOneAndUpdate } = fixture();
    expect(await repo.find('key')).toEqual({ ok: true, value: READING });
    expect(findOne).toHaveBeenCalledWith(
      { _id: 'key' },
      {
        maxTimeMS: 500,
        timeoutMS: 500,
        projection: { percent: 1, commentKey: 1 },
      },
    );
    const expiresAt = new Date();
    await repo.remember('key', READING, expiresAt);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'key' },
      { $setOnInsert: { ...READING, expiresAt } },
      {
        maxTimeMS: 500,
        timeoutMS: 500,
        upsert: true,
        returnDocument: 'after',
      },
    );
  });

  it('recovers a concurrent upsert conflict by reading the winner', async () => {
    const { repo, findOneAndUpdate } = fixture();
    findOneAndUpdate.mockRejectedValue({ code: 11000 });
    expect(await repo.remember('key', { ...READING, percent: 99 }, new Date())).toEqual({
      ok: true,
      value: READING,
    });
  });

  it('maps missing storage, read/write timeouts and an unsuccessful conflict lookup', async () => {
    const { repo, findOne, findOneAndUpdate } = fixture();
    findOne.mockRejectedValue({ code: 50 });
    expect((await repo.find('key')).ok).toBe(false);
    findOneAndUpdate.mockRejectedValue({ code: 50 });
    expect((await repo.remember('key', READING, new Date())).ok).toBe(false);
    findOneAndUpdate.mockRejectedValue({ code: 11000 });
    expect((await repo.remember('key', READING, new Date())).ok).toBe(false);
    const unavailable = new MongoGayReadingRepo({ connection: {} } as unknown as GuildConnection);
    expect((await unavailable.find('key')).ok).toBe(false);
    expect((await unavailable.remember('key', READING, new Date())).ok).toBe(false);
  });

  it('rejects corrupt snapshots and a write that returns no document', async () => {
    const { repo, findOne, findOneAndUpdate } = fixture();
    for (const percent of [-1, 101, 0.5]) {
      findOne.mockResolvedValue({ ...READING, percent });
      expect((await repo.find('key')).ok).toBe(false);
    }
    findOne.mockResolvedValue({ ...READING, commentKey: 'unsafe' });
    expect((await repo.find('key')).ok).toBe(false);
    findOneAndUpdate.mockResolvedValue(null);
    expect((await repo.remember('key', READING, new Date())).ok).toBe(false);
  });
});
