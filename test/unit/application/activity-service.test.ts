/**
 * The activity service: a post without a record is withdrawn, closing
 * announces once, cancelling stops every job, and a restart closes what
 * expired while the bot was down.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ok, err } from '../../../src/core/result';
import { databaseErrorFrom } from '../../../src/persistence/error-translator';
import {
  activityCloseJobKey,
  activityStartJobKey,
  cancelActivity,
  closeActivity,
  createActivity,
  rebootActivityJobs,
  type ActivityDeps,
} from '../../../src/application/activity/activity';

const GUILD = 'g1';

const doc = (overrides: Record<string, unknown> = {}) => ({
  activity_id: 'a1',
  message_id: 'a1',
  channel_id: 'c1',
  title: 'Games',
  creator_id: 'creator',
  expired_at: Date.now() + 60_000,
  status: 'open',
  participants: ['u1', 'u2'],
  attendance: [],
  ...overrides,
});

const build = (stored = doc()) => {
  const edit = vi.fn(async () => undefined);
  const send = vi.fn(async (_options: unknown) => ({
    id: 'a1',
    delete: vi.fn(async () => undefined),
  }));
  const channel = {
    isSendable: () => true,
    send,
    messages: { fetch: vi.fn(async () => ({ edit })) },
  };
  const activity = {
    create: vi.fn(async () => ok(stored)),
    findByActivityId: vi.fn(async () => ok(stored)),
    finish: vi.fn(async () => ok(true)),
    listAll: vi.fn(async () => ok([stored])),
    markStartNotified: vi.fn(async () => ok(true)),
  };
  const jobMap = new Map();
  const deps = {
    client: {
      guilds: {
        cache: new Map([[GUILD, { id: GUILD, channels: { cache: new Map([['c1', channel]]) } }]]),
      },
      channels: { fetch: vi.fn() },
    },
    registry: {
      getRepos: () => ({ activity }),
      getChannel: () => undefined,
      listGuildIds: () => [GUILD],
    },
    jobMap,
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    translator: { t: (key: string) => key },
  } as unknown as ActivityDeps;
  return { deps, activity, send, edit, jobMap, channel };
};

afterEach(() => vi.useRealTimers());

describe('activity service', () => {
  it('withdraws the post when the record cannot be stored', async () => {
    const { deps, activity, send, channel } = build();
    activity.create.mockResolvedValueOnce(
      err(databaseErrorFrom(new Error('down'), { operation: 't' })) as never,
    );
    const guild = deps.client.guilds.cache.get(GUILD) as never;

    await expect(
      createActivity(deps, guild, channel as never, {
        title: 'Games',
        description: '',
        creator_id: 'creator',
        expired_at: Date.now() + 60_000,
      }),
    ).rejects.toThrow();
    const message = await send.mock.results[0]?.value;
    expect(message.delete).toHaveBeenCalled();
  });

  it('pings the participants once when sign-ups close', async () => {
    const { deps, activity, send } = build();

    expect(await closeActivity(deps, GUILD, 'a1')).toBe(true);
    activity.finish.mockResolvedValueOnce(ok(false));
    expect(await closeActivity(deps, GUILD, 'a1')).toBe(false);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ allowedMentions: { users: ['u1', 'u2'] } });
  });

  it('stops the close and start jobs when cancelled', async () => {
    const { deps, jobMap } = build();
    const cancelClose = vi.fn();
    const cancelStart = vi.fn();
    jobMap.set(activityCloseJobKey('a1'), { cancel: cancelClose });
    jobMap.set(activityStartJobKey('a1'), { cancel: cancelStart });

    expect(await cancelActivity(deps, GUILD, 'a1')).toBe(true);
    expect(cancelClose).toHaveBeenCalled();
    expect(cancelStart).toHaveBeenCalled();
  });

  it('closes an activity whose deadline passed while the bot was down', async () => {
    const { deps, activity } = build(doc({ expired_at: Date.now() - 1000 }));

    await rebootActivityJobs(deps);

    await vi.waitFor(() => expect(activity.finish).toHaveBeenCalled());
  });

  it('schedules the deadline and start reminder still ahead', async () => {
    const later = Date.now() + 3_600_000;
    const { deps, jobMap } = build(doc({ starts_at: later }));

    await rebootActivityJobs(deps);

    expect(jobMap.has(activityCloseJobKey('a1'))).toBe(true);
    expect(jobMap.has(activityStartJobKey('a1'))).toBe(true);
    for (const job of jobMap.values()) (job as { cancel: () => void }).cancel();
  });
});
