import type { GuildBasedChannel } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { ArchiveChannel, ArchiveHistoryCheckpoint } from '../../../src/core/archive/types';
import { createLogger } from '../../../src/core/logger';
import type { StoredSourceWorkQuery } from '../../../src/persistence/repositories/archive.repo';
import {
  estimateSourceWork,
  orderSourcesByWork,
  storedReactionRatio,
  type SourceWorkHint,
  type StoredWork,
} from '../../../src/plugins/message-backup/flow/source-work';
import {
  FullBackupSourceOrder,
  sourceWorkHint,
} from '../../../src/plugins/message-backup/runtime/source-order';

const DAY = 86_400_000;
const CUTOFF = Date.parse('2026-01-01T00:00:00Z');
/** A snowflake created at `at`. */
const snowflake = (at: number, increment = 0): string =>
  ((BigInt(at - 1420070400000) << 22n) + BigInt(increment)).toString();
/** A source created `days` before the cutoff whose last message is at the cutoff. */
const spanned = (days: number, increment = 0): SourceWorkHint => ({
  id: snowflake(CUTOFF - days * DAY, increment),
  lastMessageId: snowflake(CUTOFF),
});
const ids = (estimates: readonly { id: string }[]) => estimates.map(({ id }) => id);

describe('source work estimate', () => {
  it('trusts stored counts over discovery once a full scan stored the history', () => {
    const large = { ...spanned(1000, 1), storedComplete: true as const };
    const small = { ...spanned(10, 2), storedComplete: true as const };
    const stored = new Map<string, StoredWork>([
      [large.id, { messages: 100, reactionLists: 0 }],
      [small.id, { messages: 5000, reactionLists: 0 }],
    ]);
    const order = orderSourcesByWork([large, small], stored, CUTOFF);
    expect(order).toEqual([
      { id: small.id, basis: 'stored', work: 50 },
      { id: large.id, basis: 'stored', work: 1 },
    ]);
  });

  it('treats stored counts as a floor until a full scan completed', () => {
    const partial = spanned(1000);
    expect(estimateSourceWork(partial, { messages: 100 }, CUTOFF)).toEqual({
      id: partial.id,
      basis: 'span',
      work: 240,
    });
    expect(estimateSourceWork(partial, { messages: 50_000 }, CUTOFF)).toEqual({
      id: partial.id,
      basis: 'stored',
      work: 500,
    });
  });

  it('weighs a reaction list like a page of 100 messages', () => {
    const plain = { ...spanned(1, 1), storedComplete: true as const };
    const reacted = { ...spanned(1, 2), storedComplete: true as const };
    const stored = new Map<string, StoredWork>([
      [plain.id, { messages: 1000, reactionLists: 0 }],
      [reacted.id, { messages: 200, reactionLists: 50 }],
    ]);
    expect(orderSourcesByWork([plain, reacted], stored, CUTOFF)).toEqual([
      { id: reacted.id, basis: 'stored', work: 52 },
      { id: plain.id, basis: 'stored', work: 10 },
    ]);
  });

  it('orders discovery estimates with the stored reaction ratio', () => {
    // One reaction list per stored message: a 2000-message thread is 2020 requests.
    const reacted = { ...spanned(1, 1), storedComplete: true as const };
    const thread = { id: snowflake(CUTOFF - DAY, 2), threadMessageCount: 2000 };
    const stored = new Map<string, StoredWork>([
      [reacted.id, { messages: 1000, reactionLists: 1000 }],
    ]);
    expect(orderSourcesByWork([reacted, thread], stored, CUTOFF)).toEqual([
      { id: thread.id, basis: 'thread-count', work: 2020 },
      { id: reacted.id, basis: 'stored', work: 1010 },
    ]);
  });

  it('gives discovery estimates the stored reaction ratio', () => {
    const stored = new Map<string, StoredWork>([
      ['1', { messages: 300, reactionLists: 30 }],
      ['2', { messages: 100, reactionLists: 10 }],
      ['3', { messages: 600 }],
    ]);
    expect(storedReactionRatio(stored)).toBe(0.1);
    expect(storedReactionRatio(new Map())).toBe(0);
    const thread = { id: snowflake(CUTOFF - DAY), threadMessageCount: 1000 };
    expect(estimateSourceWork(thread, undefined, CUTOFF, 0.1).work).toBeCloseTo(110);
  });

  it('uses a thread message count, widened by span where Discord stopped counting', () => {
    const recent = { id: snowflake(Date.UTC(2024, 0, 1)), threadMessageCount: 500 };
    expect(estimateSourceWork(recent, undefined, CUTOFF)).toEqual({
      id: recent.id,
      basis: 'thread-count',
      work: 5,
    });
    // Created before July 2022 with 50 counted: the count may have stopped at 50.
    const legacy = {
      id: snowflake(Date.UTC(2021, 0, 1)),
      threadMessageCount: 50,
      lastMessageId: snowflake(Date.UTC(2021, 0, 101)),
    };
    expect(estimateSourceWork(legacy, undefined, CUTOFF)).toEqual({
      id: legacy.id,
      basis: 'thread-count',
      work: 24,
    });
    // An invalid count falls back to the span.
    for (const threadMessageCount of [Number.NaN, -1])
      expect(
        estimateSourceWork({ ...spanned(10), threadMessageCount }, undefined, CUTOFF),
      ).toMatchObject({ basis: 'span', work: 2.4 });
  });

  it('measures a span to the earliest of the cutoff and the last message', () => {
    const after = { id: snowflake(CUTOFF - 10 * DAY), lastMessageId: snowflake(CUTOFF + 99 * DAY) };
    expect(estimateSourceWork(after, undefined, CUTOFF).work).toBeCloseTo(2.4);
    const quiet = { id: snowflake(CUTOFF - 10 * DAY), lastMessageId: snowflake(CUTOFF - 9 * DAY) };
    expect(estimateSourceWork(quiet, undefined, CUTOFF).work).toBeCloseTo(0.24);
  });

  it('ranks unknown sources last and breaks ties by the older channel ID', () => {
    const unknownOld = { id: '5' };
    const unknownNew = { id: '40' };
    const empty = { ...spanned(1, 3), storedComplete: true as const };
    const tieLate = { ...spanned(100, 2) };
    const tieEarly = { ...spanned(100, 1) };
    const invalid = { id: 'not-a-snowflake', threadMessageCount: 10 };
    const stored = new Map<string, StoredWork>([[empty.id, { messages: 0 }]]);
    const order = orderSourcesByWork(
      [unknownNew, invalid, empty, tieLate, unknownOld, tieEarly],
      stored,
      CUTOFF,
    );
    expect(ids(order)).toEqual([
      tieEarly.id,
      tieLate.id,
      empty.id,
      unknownOld.id,
      unknownNew.id,
      invalid.id,
    ]);
    expect(order.slice(-3).map(({ basis }) => basis)).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it('orders resumed sources by the work they have left', () => {
    // Nearly done: 1000 days of history, scanned back to 10 days after its creation.
    const created = CUTOFF - 1000 * DAY;
    const resumed: SourceWorkHint = {
      ...spanned(1000, 1),
      resume: { before: snowflake(created + 10 * DAY), scanned: 20_000 },
    };
    const fresh = spanned(100, 2);
    expect(ids(orderSourcesByWork([resumed, fresh], new Map(), CUTOFF))).toEqual([
      fresh.id,
      resumed.id,
    ]);
    const thread = {
      id: snowflake(Date.UTC(2024, 0, 1)),
      threadMessageCount: 500,
      resume: { before: snowflake(Date.UTC(2024, 6, 1)), scanned: 450 },
    };
    expect(estimateSourceWork(thread, undefined, CUTOFF).work).toBeCloseTo(0.5);
  });
});

const checkpoint = (extra: Partial<ArchiveHistoryCheckpoint>): ArchiveHistoryCheckpoint => ({
  runId: 'full:1',
  cutoff: CUTOFF,
  before: snowflake(CUTOFF - DAY),
  complete: false,
  scanned: 300,
  pageSequence: 3,
  ...extra,
});
const record = (channelId: string, checkpoints: ArchiveChannel['checkpoints']): ArchiveChannel => ({
  channelId,
  access: 'readable',
  observedAt: 1,
  checkpoints,
});
const source = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, ...extra }) as unknown as GuildBasedChannel;

describe('source work hints', () => {
  it('reads discovery fields and this run’s unfinished checkpoint', () => {
    const thread = source('10', { messageCount: 7, lastMessageId: '99' });
    expect(
      sourceWorkHint(thread, record('10', { 'full-backup': checkpoint({}) }), 'full:1'),
    ).toEqual({
      id: '10',
      threadMessageCount: 7,
      lastMessageId: '99',
      resume: { before: snowflake(CUTOFF - DAY), scanned: 300 },
    });
    const text = source('20', { messageCount: null, lastMessageId: null });
    expect(sourceWorkHint(text, undefined, 'full:1')).toEqual({ id: '20' });
  });

  it('resumes only an unfinished source of the same run that scanned a page', () => {
    for (const previous of [
      checkpoint({ runId: 'full:0' }),
      checkpoint({ complete: true }),
      checkpoint({ pageSequence: 0 }),
      checkpoint({ pageSequence: undefined }),
      checkpoint({ before: 'not-a-snowflake' }),
    ])
      expect(
        sourceWorkHint(source('10'), record('10', { 'full-backup': previous }), 'full:1').resume,
      ).toBeUndefined();
  });

  it('marks stored history complete only after a full scan without a lower bound', () => {
    const hint = (checkpoints: ArchiveChannel['checkpoints']) =>
      sourceWorkHint(source('10'), record('10', checkpoints), 'full:1').storedComplete;
    expect(hint({ 'full-backup': checkpoint({ runId: 'full:0', complete: true }) })).toBe(true);
    expect(hint({ periodic: checkpoint({ runId: 'p', complete: true }) })).toBe(true);
    expect(hint({ periodic: checkpoint({ runId: 'p', complete: true, lower: '5' }) })).toBe(
      undefined,
    );
    expect(hint({ periodic: checkpoint({ runId: 'p' }) })).toBe(undefined);
  });
});

describe('full backup source order', () => {
  const logger = createLogger({ level: 'silent', pretty: false });
  const scan = { guildId: '1', runId: 'full:1', cutoff: CUTOFF };
  const channels = [
    source(snowflake(CUTOFF - 10 * DAY, 1), { lastMessageId: snowflake(CUTOFF - 1) }),
    source(snowflake(CUTOFF - 100 * DAY, 2), { lastMessageId: snowflake(CUTOFF - 1) }),
    source(snowflake(CUTOFF - 50 * DAY, 3)),
  ];
  const [young, old, unknown] = channels.map(({ id }) => id) as [string, string, string];
  const orderOf = async (
    storedSourceWork: (query: StoredSourceWorkQuery) => Promise<unknown>,
    records: ReadonlyMap<string, ArchiveChannel> = new Map(),
    signal = new AbortController().signal,
  ) => {
    const repo = { storedSourceWork: vi.fn(storedSourceWork) };
    const order = new FullBackupSourceOrder(repo as never, logger, scan);
    const ordered = (await order.order(channels, records, signal)).map(({ id }) => id);
    return { repo, ordered, order };
  };

  it('orders by stored work summed with reaction lists', async () => {
    const { repo, ordered } = await orderOf(async () => [
      { channelId: unknown, messages: 100_000, reactionLists: 50 },
      { channelId: young, messages: 20, reactionLists: 5 },
    ]);
    expect(ordered).toEqual([unknown, old, young]);
    expect(repo.storedSourceWork).toHaveBeenCalledTimes(1);
    expect(repo.storedSourceWork).toHaveBeenCalledWith(
      expect.objectContaining({ before: CUTOFF, reactions: true }),
    );
  });

  it('falls back to the message count, then to discovery alone', async () => {
    const failing = await orderOf(async (query) => {
      if (query.reactions) throw new Error('operation exceeded time limit');
      return [{ channelId: unknown, messages: 100_000 }];
    });
    expect(failing.repo.storedSourceWork.mock.calls.map(([query]) => query.reactions)).toEqual([
      true,
      false,
    ]);
    expect(failing.ordered).toEqual([unknown, old, young]);
    const down = await orderOf(async () => {
      throw new Error('query failed');
    });
    expect(down.repo.storedSourceWork).toHaveBeenCalledTimes(2);
    expect(down.ordered).toEqual([old, young, unknown]);
  });

  it('skips the cheaper estimate once the connection is lost or the scan stopped', async () => {
    const lost = await orderOf(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'MongoNetworkError' });
    });
    expect(lost.repo.storedSourceWork).toHaveBeenCalledTimes(1);
    expect(lost.ordered).toEqual([old, young, unknown]);
    const stopped = new AbortController();
    stopped.abort();
    const idle = await orderOf(async () => [], new Map(), stopped.signal);
    expect(idle.repo.storedSourceWork).not.toHaveBeenCalled();
  });

  it('recounts resumed sources below their cursors, once per scan', async () => {
    const records = new Map([[old, record(old, { 'full-backup': checkpoint({}) })]]);
    const { repo, order, ordered } = await orderOf(
      async (query) =>
        query.sources === undefined
          ? [
              { channelId: old, messages: 100_000, reactionLists: 0 },
              { channelId: young, messages: 50_000, reactionLists: 0 },
            ]
          : [{ channelId: old, messages: 10, reactionLists: 0 }],
      records,
    );
    expect(repo.storedSourceWork.mock.calls.map(([query]) => query.sources)).toEqual([
      undefined,
      new Map([[old, CUTOFF - DAY]]),
    ]);
    // Only 10 stored messages remain below the cursor; its span to the cursor wins.
    expect(ordered).toEqual([young, old, unknown]);
    await order.order(channels.slice(0, 1), records, new AbortController().signal);
    expect(repo.storedSourceWork).toHaveBeenCalledTimes(2);
  });

  it('keeps whole stored counts when the resumed recount fails', async () => {
    const records = new Map([[old, record(old, { 'full-backup': checkpoint({}) })]]);
    const { repo, ordered } = await orderOf(async (query) => {
      if (query.sources !== undefined) throw new Error('operation exceeded time limit');
      return [
        { channelId: old, messages: 100_000, reactionLists: 0 },
        { channelId: young, messages: 50_000, reactionLists: 0 },
      ];
    }, records);
    expect(repo.storedSourceWork).toHaveBeenCalledTimes(2);
    expect(ordered).toEqual([old, young, unknown]);
  });

  it('puts sources this run finished last, without estimating them', async () => {
    const records = new Map([
      [unknown, record(unknown, { 'full-backup': checkpoint({ complete: true }) })],
    ]);
    const { ordered } = await orderOf(
      async () => [{ channelId: unknown, messages: 100_000, reactionLists: 0 }],
      records,
    );
    expect(ordered).toEqual([old, young, unknown]);
  });

  it('keeps discovery order when ordering fails', async () => {
    const records = {
      get: () => {
        throw new Error('broken record');
      },
    } as unknown as ReadonlyMap<string, ArchiveChannel>;
    const { ordered } = await orderOf(async () => [], records as never);
    expect(ordered).toEqual([young, old, unknown]);
  });
});
