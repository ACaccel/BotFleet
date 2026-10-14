import { describe, expect, it } from 'vitest';

import { ok } from '../../../../src/core/result';
import {
  createTicket,
  setTicketClosed,
  ticketNumberIn,
  verifyHub,
} from '../../../../src/application/bug-report/tickets';
import { parseBugReportConfig } from '../../../../src/application/bug-report/config';
import { buildDeps, buildRepo, HUB, ticket } from './fakes';

const args = {
  reporter: { id: 'reporter' } as never,
  source: { guildId: 'g1', guildName: 'Guild', channelId: 'c1' },
  type: 'bug' as const,
  title: 'It broke',
  content: 'Steps...',
  now: 1_000_000,
};

describe('bug report config', () => {
  it('requires a hub with Discord IDs', () => {
    expect(parseBugReportConfig({ bug_report: { hub: HUB } }).hub).toEqual(HUB);
    expect(() => parseBugReportConfig({})).toThrow(/bug_report\.hub is required/);
    expect(() =>
      parseBugReportConfig({ bug_report: { hub: { guildId: 'x', channelId: 'y' } } }),
    ).toThrow();
  });
});

describe('createTicket', () => {
  it('posts the ticket with its tags and DMs the reporter', async () => {
    const repo = buildRepo();
    const { deps, forum, send } = buildDeps(repo);

    const outcome = await createTicket(deps, args);

    expect(outcome).toEqual({ status: 'created', number: 7, dmDelivered: true });
    expect(forum.threads.create.mock.calls[0]?.[0]).toMatchObject({
      name: '[Nijika] #7 It broke',
      appliedTags: ['tag-bug', 'tag-open'],
    });
    expect(repo.setThread).toHaveBeenCalledWith('bot', 7, 'thread-7');
    expect(send).toHaveBeenCalledOnce();
  });

  it('notes a reporter who cannot be DMed', async () => {
    const repo = buildRepo();
    const { deps, thread } = buildDeps(repo, { dmFails: true });

    expect(await createTicket(deps, args)).toMatchObject({ dmDelivered: false });
    expect(repo.markDmFailed).toHaveBeenCalledWith('bot', 7);
    expect(thread.send).toHaveBeenCalled();
  });

  it('removes the reserved record when the post cannot be created', async () => {
    const repo = buildRepo();
    const { deps, forum } = buildDeps(repo);
    forum.threads.create.mockRejectedValueOnce(new Error('Missing Permissions'));

    await expect(createTicket(deps, args)).rejects.toThrow('Missing Permissions');
    expect(repo.deleteByNumber).toHaveBeenCalledWith('bot', 7);
  });

  it('limits open tickets and how often a member reports', async () => {
    const full = buildRepo();
    full.listOpenByReporter.mockResolvedValueOnce(ok([{}, {}, {}] as never[]));
    expect(await createTicket(buildDeps(full).deps, args)).toEqual({ status: 'too_many', max: 3 });

    const recent = buildRepo();
    recent.lastCreatedAt.mockResolvedValueOnce(ok(args.now - 60_000));
    expect(await createTicket(buildDeps(recent).deps, args)).toEqual({
      status: 'cooldown',
      retryAt: args.now - 60_000 + 600_000,
    });
  });
});

describe('setTicketClosed', () => {
  it('closes once, locks the post and tells the reporter', async () => {
    const repo = buildRepo();
    const { deps, thread, send } = buildDeps(repo);

    expect(await setTicketClosed(deps, thread as never, ticket() as never, true, 'admin', 5)).toBe(
      true,
    );
    expect(repo.setStatus).toHaveBeenCalledWith('bot', 7, 'closed', { at: 5, by: 'admin' });
    expect(thread.setLocked).toHaveBeenCalledWith(true);
    expect(send).toHaveBeenCalled();
    expect(
      await setTicketClosed(
        deps,
        thread as never,
        ticket({ status: 'closed' }) as never,
        true,
        'admin',
        6,
      ),
    ).toBe(false);
  });
});

describe('hub checks', () => {
  it('reads ticket numbers back from DM footers', () => {
    expect(ticketNumberIn('replies:bug_report.dm_footer #12')).toBe(12);
    expect(ticketNumberIn(undefined)).toBeUndefined();
  });

  it('refuses a hub where the bot lacks permissions', async () => {
    const { deps } = buildDeps(buildRepo(), { permissions: false });
    await expect(verifyHub(deps)).rejects.toThrow(/missing permissions: ViewChannel/);
  });
});
