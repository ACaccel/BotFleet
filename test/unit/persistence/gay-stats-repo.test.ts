import { describe, expect, it, vi } from 'vitest';
import type { GuildConnection } from '../../../src/persistence/connection';
import { MongoGayStatsRepo } from '../../../src/persistence/repositories/gay-stats.repo';

const query = {
  userIds: ['a', 'b'],
  channelIds: ['visible'],
  window: { startMs: 0, endMs: 1 },
  timeZone: 'UTC',
};
const fixture = () => {
  const toArray = vi.fn().mockResolvedValue([{ members: [], shared: [] }]);
  const aggregate = vi.fn().mockReturnValue({ toArray });
  const find = vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
  const conn = {
    connection: { db: { collection: () => ({ aggregate, find }) } },
  } as unknown as GuildConnection;
  return { repo: new MongoGayStatsRepo(conn), aggregate, find, toArray };
};

describe('MongoGayStatsRepo query budgets', () => {
  it('bounds server and client time, uses the channel/time index, and returns summary fields only', async () => {
    const { repo, aggregate } = fixture();
    expect(await repo.summarize(query)).toEqual({ ok: true, value: undefined });
    const [pipeline, options] = aggregate.mock.calls[0]!;
    expect(options.maxTimeMS).toBeGreaterThan(0);
    expect(options.maxTimeMS).toBeLessThanOrEqual(500);
    expect(options.timeoutMS).toBe(options.maxTimeMS);
    expect(options.hint).toEqual({ channelId: 1, createdTimestamp: 1 });
    expect(options.allowDiskUse).toBe(false);
    expect(pipeline[0].$match.channelId).toEqual({ $in: ['visible'] });
  });

  it('retries only a missing-index hint using the remaining shared time budget', async () => {
    const { repo, aggregate, toArray } = fixture();
    toArray.mockRejectedValueOnce({
      code: 2,
      message: 'hint provided does not correspond to an existing index',
    });
    await repo.summarize(query);
    expect(aggregate).toHaveBeenCalledTimes(2);
    expect(aggregate.mock.calls[1]![1].hint).toBeUndefined();
    expect(aggregate.mock.calls[1]![1].timeoutMS).toBeLessThanOrEqual(
      aggregate.mock.calls[0]![1].timeoutMS,
    );
  });

  it.each([
    [{ code: 50 }, 'DATABASE_QUERY_TIMEOUT'],
    [{ name: 'MongoOperationTimeoutError', message: 'Operation timeout' }, 'DATABASE_TIMEOUT'],
    [{ code: 2, message: 'Invalid pipeline' }, 'DATABASE_UNKNOWN'],
  ])('maps a failed query without retrying unrelated failures', async (failure, code) => {
    const { repo, aggregate, toArray } = fixture();
    toArray.mockRejectedValueOnce(failure);
    const result = await repo.summarize(query);
    expect(result.ok ? undefined : result.error.code).toBe(code);
    expect(aggregate).toHaveBeenCalledTimes(1);
  });

  it('bounds channel metadata queries and projects only permission-relevant fields', async () => {
    const { repo, find } = fixture();
    await repo.listChannels();
    expect(find).toHaveBeenCalledWith(
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
        maxTimeMS: 500,
        timeoutMS: 500,
      },
    );
  });

  it('validates query arguments before reaching MongoDB', async () => {
    const { repo, aggregate } = fixture();
    await expect(repo.summarize({ ...query, userIds: [] })).rejects.toThrow(TypeError);
    await expect(repo.summarize({ ...query, userIds: ['a', 'b', 'c'] })).rejects.toThrow(TypeError);
    await expect(repo.summarize({ ...query, timeZone: 'Invalid/Zone' })).rejects.toThrow(
      RangeError,
    );
    await expect(repo.summarize({ ...query, window: { startMs: 1, endMs: 0 } })).rejects.toThrow(
      TypeError,
    );
    expect(aggregate).not.toHaveBeenCalled();
  });
});
