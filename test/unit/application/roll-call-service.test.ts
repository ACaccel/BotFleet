/**
 * Roll calls ping each called member once, accept check-ins only from
 * them, and record attendance on their activity exactly once.
 */
import { describe, expect, it, vi } from 'vitest';

import { ok } from '../../../src/core/result';
import {
  checkIn,
  closeRollCall,
  startRollCall,
  type RollCallDeps,
} from '../../../src/application/roll-call/roll-call';
import { echoTranslator } from '../../fixtures/runtime';

const GUILD = 'g1';

const build = (stored: Record<string, unknown>) => {
  const edit = vi.fn(async () => undefined);
  const send = vi.fn(async (_options: unknown) => ({ id: 'm1', delete: vi.fn() }));
  const channel = {
    id: 'c1',
    isSendable: () => true,
    send,
    messages: { fetch: vi.fn(async () => ({ edit })) },
  };
  const rollCall = {
    create: vi.fn(async () => ok({ message_id: 'm1', ...stored })),
    findByMessageId: vi.fn(async () => ok({ message_id: 'm1', channel_id: 'c1', ...stored })),
    checkIn: vi.fn(async () => ok(false)),
    close: vi.fn(async () => ok(true)),
  };
  const activity = {
    addAttendance: vi.fn(async () => ok(true)),
    findByActivityId: vi.fn(async () => ok(undefined)),
  };
  const guild = { id: GUILD, channels: { cache: new Map([['c1', channel]]) } };
  const deps = {
    client: { guilds: { cache: new Map([[GUILD, guild]]) }, channels: { fetch: vi.fn() } },
    registry: {
      getRepos: () => ({ rollCall, activity }),
      getChannel: () => undefined,
      listGuildIds: () => [],
    },
    jobMap: new Map(),
    logger: { error: vi.fn(), warn: vi.fn() },
    translator: echoTranslator(),
  } as unknown as RollCallDeps;
  return { deps, rollCall, activity, send, guild, channel };
};

const base = { targets: ['u1', 'u2'], present: [], closed: false, creator_id: 'caller' };

describe('roll calls', () => {
  it('pings only the called members, in the message content', async () => {
    const { deps, send, guild, channel } = build(base);

    await startRollCall(deps, {
      guild: guild as never,
      channel: channel as never,
      creatorId: 'caller',
      targets: ['u1', 'u2'],
      persona: 'Bot',
    });

    expect(send.mock.calls[0]?.[0]).toMatchObject({
      content: '<@u1> <@u2>',
      allowedMentions: { users: ['u1', 'u2'] },
    });
  });

  it('explains why a check-in changed nothing', async () => {
    const { deps, rollCall } = build(base);

    expect(await checkIn(deps, GUILD, 'm1', 'stranger')).toBe('not_called');
    rollCall.findByMessageId.mockResolvedValueOnce(
      ok({ ...base, present: ['u1'], message_id: 'm1', channel_id: 'c1' }) as never,
    );
    expect(await checkIn(deps, GUILD, 'm1', 'u1')).toBe('already');
    rollCall.checkIn.mockResolvedValueOnce(ok(true));
    expect(await checkIn(deps, GUILD, 'm1', 'u2')).toBe('checked_in');
  });

  it('records attendance on the activity once', async () => {
    const { deps, rollCall, activity } = build({ ...base, present: ['u1'], activity_id: 'a1' });

    expect(await closeRollCall(deps, GUILD, 'm1')).toBe(true);
    rollCall.close.mockResolvedValueOnce(ok(false));
    expect(await closeRollCall(deps, GUILD, 'm1')).toBe(false);

    expect(activity.addAttendance).toHaveBeenCalledTimes(1);
    expect(activity.addAttendance).toHaveBeenCalledWith(
      'a1',
      expect.objectContaining({ present: ['u1'], total: 2 }),
    );
  });
});
