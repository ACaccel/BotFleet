import { describe, expect, it, vi } from 'vitest';

import { ARCHIVE_LIMITS } from '../../../src/core/archive/limits';
import { ArchivePipelineBudget } from '../../../src/plugins/message-backup/flow/pipeline';
import { fetchReactionMemberships } from '../../../src/plugins/message-backup/flow/reactions';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A reaction-list user with every field Discord returns at its longest. */
const longestUser = (index: number): Record<string, unknown> => {
  const id = String(10n ** 19n + BigInt(index));
  const hash = `a_${'f'.repeat(32)}`;
  const tag = { identity_guild_id: id, identity_enabled: true, tag: '漢'.repeat(4), badge: hash };
  return {
    id,
    username: 'x'.repeat(32),
    global_name: '漢'.repeat(32),
    avatar: hash,
    banner: hash,
    discriminator: '0000',
    public_flags: 4_194_303,
    flags: 4_194_303,
    accent_color: 16_777_215,
    banner_color: '#ffffff',
    avatar_decoration_data: { asset: hash, sku_id: id, expires_at: 9_999_999_999_999 },
    collectibles: {
      nameplate: {
        sku_id: id,
        asset: `nameplates/nameplates/${'x'.repeat(64)}/`,
        label: `COLLECTIBLES_NAMEPLATES_${'X'.repeat(64)}`,
        palette: 'x'.repeat(16),
        expires_at: 9_999_999_999_999,
      },
    },
    display_name_styles: { font_id: 999_999, effect_id: 999_999, colors: [16_777_215, 1] },
    clan: tag,
    primary_guild: tag,
    bot: false,
    system: false,
  };
};

const fetchOne = (
  budget: ArchivePipelineBudget,
  get: (...args: unknown[]) => Promise<unknown>,
  stage: () => Promise<void> = async () => undefined,
) =>
  fetchReactionMemberships({
    rest: { get } as never,
    channelId: '10',
    messageId: '100',
    streams: [{ emoji: 'x', kinds: ['normal'] }],
    isCurrent: () => true,
    stage,
    pipelineBudget: budget,
  });

describe('reaction page reservation', () => {
  it('covers a full page of the longest users with headroom', () => {
    const page = Array.from({ length: 100 }, (_, index) => longestUser(index));
    const bytes = Buffer.byteLength(JSON.stringify(page), 'utf8');
    expect(ARCHIVE_LIMITS.reactionPageBytes).toBe(256 * 1024);
    expect(bytes * 1.9).toBeLessThan(ARCHIVE_LIMITS.reactionPageBytes);
  });

  it('reserves one page estimate per read, so the 16 MiB lane runs 64 reads at once', async () => {
    const budget = new ArchivePipelineBudget();
    const reserve = vi.spyOn(budget, 'reserve');
    const gate = deferred<void>();
    const get = vi.fn(async () => {
      await gate.promise;
      return [{ id: '1' }];
    });
    const lanes = budget.snapshot().reactionCapacityBytes / ARCHIVE_LIMITS.reactionPageBytes;
    expect(budget.snapshot().reactionCapacityBytes).toBe(16 * 1024 * 1024);
    expect(lanes).toBe(64);
    const reads = Array.from({ length: lanes + 1 }, () => fetchOne(budget, get));
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(lanes));
    expect(reserve).toHaveBeenCalledWith(ARCHIVE_LIMITS.reactionPageBytes, undefined, 'reactions');
    expect(budget.snapshot()).toMatchObject({
      reactionReservedBytes: budget.snapshot().reactionCapacityBytes,
      reactionWaiting: 1,
    });
    gate.resolve();
    const results = await Promise.all(reads);
    expect(results.every(([stream]) => stream?.complete === true)).toBe(true);
    expect(get).toHaveBeenCalledTimes(lanes + 1);
    expect(budget.snapshot().reservedBytes).toBe(0);
  });

  it('grows the reservation for a larger response before staging it', async () => {
    const budget = new ArchivePipelineBudget();
    const response = [{ id: '1', banner: 'x'.repeat(1024 * 1024) }];
    const bytes = Buffer.byteLength(JSON.stringify(response), 'utf8');
    let reservedWhileParsed = 0;
    const results = await fetchOne(
      budget,
      async () => response,
      async () => {
        reservedWhileParsed = budget.snapshot().peakReservedBytes;
      },
    );
    expect(results[0]?.complete).toBe(true);
    expect(reservedWhileParsed).toBe(bytes);
    expect(budget.snapshot().reservedBytes).toBe(0);
  });
});

describe('pipeline reservation growth', () => {
  it('grows in place when the lane has room and rejects impossible sizes', async () => {
    const budget = new ArchivePipelineBudget(16);
    const release = await budget.reserve(4);
    await release.grow(3);
    await release.grow(10);
    expect(budget.snapshot().historyReservedBytes).toBe(10);
    await expect(release.grow(15)).rejects.toThrow('archive-pipeline-item-too-large');
    release.shrink(2);
    expect(budget.snapshot().reservedBytes).toBe(2);
    release();
    await expect(release.grow(4)).rejects.toThrow('archive-pipeline-reservation-released');
    expect(budget.snapshot().reservedBytes).toBe(0);
  });

  it('gives back its bytes while waiting and is admitted before newer requests', async () => {
    const budget = new ArchivePipelineBudget(16);
    const first = await budget.reserve(5);
    const second = await budget.reserve(5);
    const grown = first.grow(12);
    // While it waits, the grower holds nothing, but the freed bytes stay behind it.
    expect(budget.snapshot()).toMatchObject({ historyReservedBytes: 5, historyWaiting: 1 });
    let late = false;
    const newer = budget.reserve(4).then((release) => {
      late = true;
      return release;
    });
    await flush();
    expect(late).toBe(false);
    second();
    await grown;
    expect(budget.snapshot().historyReservedBytes).toBe(12);
    first();
    (await newer)();
    expect(budget.snapshot().reservedBytes).toBe(0);
  });

  it('never deadlocks when every holder grows at once', async () => {
    const budget = new ArchivePipelineBudget(16);
    const holders = await Promise.all([budget.reserve(7), budget.reserve(7)]);
    await Promise.all(
      holders.map(async (release) => {
        await release.grow(12);
        release();
      }),
    );
    expect(budget.snapshot()).toMatchObject({ reservedBytes: 0, waiting: 0 });
  });

  it('cancels a waiting grower and frees what it is admitted with after release', async () => {
    const budget = new ArchivePipelineBudget(16);
    const blocker = await budget.reserve(10);
    const cancelled = await budget.reserve(2);
    const controller = new AbortController();
    const waiting = cancelled.grow(8, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow('archive-pipeline-cancelled');
    cancelled();
    const released = await budget.reserve(2);
    const admitted = released.grow(8);
    released();
    blocker();
    await admitted;
    expect(budget.snapshot()).toMatchObject({ reservedBytes: 0, waiting: 0 });
  });
});
