/**
 * The "which ticket?" menu a reporter with several open tickets gets for
 * a DM. Picking one relays the DM into that ticket's hub post; a ticket
 * that is not the picker's own must look exactly like a missing one.
 *
 * The relay runs for real against a fake hub thread; only the ticket
 * store is stubbed, because it opens the hub guild's MongoDB connection.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbedBuilder } from 'discord.js';

import BugTicketPick from '../../../../src/handlers/select-menus/bug_ticket_pick';
import { ticketRepo } from '../../../../src/application/bug-report/tickets';
import { err, ok } from '../../../../src/core/result';
import { databaseErrorFrom } from '../../../../src/persistence/error-translator';
import { buildFakeBot, echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';
import {
  buildStringSelectInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';
import { buildMessage } from '../../../fixtures/discord/message-builder';

vi.mock('../../../../src/application/bug-report/tickets', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  ticketRepo: vi.fn(),
}));

const HUB = { guildId: '100000000000000001', channelId: '100000000000000002' };

const ticket = (overrides: Record<string, unknown> = {}) => ({
  bot_id: 'bot-1',
  number: 7,
  reporter_id: 'reporter',
  thread_id: 'thread-7',
  status: 'open',
  type: 'bug',
  ...overrides,
});

const DM = buildMessage({
  id: 'dm-1',
  guildId: null,
  content: 'More details',
  author: { id: 'reporter', bot: false, displayName: 'Reporter' },
});

interface PickInput {
  readonly found?: ReturnType<typeof ticket> | undefined;
  readonly findFails?: boolean;
  /** `false`: no ticket store, as without MongoDB. */
  readonly store?: boolean;
  readonly userId?: string;
  readonly dmId?: string;
  /** `false`: the hub thread is gone. */
  readonly thread?: boolean;
}

const ticketRepoMock = vi.mocked(ticketRepo);

beforeEach(() => ticketRepoMock.mockReset());

const pick = async (input: PickInput = {}) => {
  const findByNumber = vi.fn(async (_botId: string, _number: number) =>
    input.findFails === true
      ? err(databaseErrorFrom(new Error('boom'), { operation: 'test' }))
      : ok('found' in input ? input.found : ticket()),
  );
  ticketRepoMock.mockResolvedValue(
    // The handler reads only `findByNumber`; the store is otherwise opaque here.
    input.store === false ? undefined : ({ findByNumber } as never),
  );
  const send = vi.fn(async (_payload: { embeds: EmbedBuilder[] }) => undefined);
  const thread = { id: 'thread-7', isThread: () => true, send };
  const { bot } = buildFakeBot({
    translator: echoTranslatorWithParams(),
    config: { bug_report: { hub: HUB } },
    clientId: 'bot-1',
    personaName: 'Nijika',
    connectionManager: undefined,
    isAdmin: () => false,
    client: {
      channels: {
        fetch: async (id: string) => (input.thread !== false && id === 'thread-7' ? thread : null),
      },
    },
  });
  const sink = newInteractionSink();
  await new BugTicketPick().execute(
    buildStringSelectInteraction({
      customId: `bug_ticket_pick|${input.dmId ?? 'dm-1'}`,
      values: ['7'],
      userId: input.userId ?? 'reporter',
      guildId: null,
      channelMessages: { 'dm-1': DM },
      sink,
    }),
    bot,
  );
  return { sink, send, findByNumber };
};

describe('bug_ticket_pick select menu', () => {
  it("relays the DM into the picked ticket's post and closes the menu", async () => {
    const { sink, send, findByNumber } = await pick();

    expect(findByNumber).toHaveBeenCalledWith('bot-1', 7);
    expect(sink.updates).toEqual([
      { content: 'replies:bug_report.pick_relayed:{"number":7}', components: [] },
    ]);
    expect(send.mock.calls[0]?.[0].embeds[0]?.toJSON()).toMatchObject({
      author: { name: 'replies:bug_report.from_reporter:{"name":"Reporter"}' },
      description: 'More details',
    });
  });

  it('tells the reporter a closed ticket takes no more messages', async () => {
    const { sink, send } = await pick({ found: ticket({ status: 'closed' }) });

    expect(sink.updates[0]?.content).toBe('replies:bug_report.dm_ticket_closed:{"number":7}');
    expect(send).not.toHaveBeenCalled();
  });

  it('says the relay failed when the hub post is gone', async () => {
    const { sink } = await pick({ thread: false });

    expect(sink.updates[0]?.content).toBe('replies:bug_report.dm_relay_failed:{"number":7}');
  });

  it.each([
    ["another reporter's ticket", { found: ticket({ reporter_id: 'someone-else' }) }],
    ['a deleted ticket', { found: undefined }],
    ['a DM that can no longer be fetched', { dmId: 'dm-gone' }],
    ['a bot without a ticket store', { store: false }],
  ])('answers %s as an unknown ticket and relays nothing', async (_case, input: PickInput) => {
    const { sink, send } = await pick(input);

    expect(sink.updates).toEqual([
      { content: 'replies:bug_report.dm_unknown_ticket', components: [] },
    ]);
    expect(send).not.toHaveBeenCalled();
  });

  it('propagates a store failure to the dispatcher instead of answering', async () => {
    await expect(pick({ findFails: true })).rejects.toMatchObject({ name: 'DatabaseError' });
  });
});
