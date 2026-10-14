import { describe, expect, it, vi } from 'vitest';

import { ok } from '../../../../src/core/result';
import { relayAdminMessage, relayReporterDm } from '../../../../src/application/bug-report/relay';
import { buildDeps, buildRepo, HUB, ticket } from './fakes';

const adminMessage = (content: string) => ({
  content,
  author: { bot: false, displayName: 'Admin' },
  member: { displayName: 'Admin' },
  attachments: new Map(),
  channel: { id: 'thread-7', isThread: () => true, parentId: HUB.channelId },
  react: vi.fn(async () => undefined),
});

const dm = (overrides: Record<string, unknown> = {}) => ({
  id: 'dm-1',
  content: 'More details',
  guildId: null,
  author: { id: 'reporter', bot: false, displayName: 'Reporter' },
  attachments: new Map(),
  reference: undefined as { messageId: string } | undefined,
  channel: { messages: { fetch: vi.fn() } },
  reply: vi.fn(async (_options: unknown) => undefined),
  react: vi.fn(async () => undefined),
  ...overrides,
});

describe('admin replies', () => {
  it('forwards to the reporter, marks delivery and moves the ticket on', async () => {
    const repo = buildRepo();
    const { deps, send } = buildDeps(repo);
    const message = adminMessage('Fixed in the next release');

    await relayAdminMessage(deps, message as never);

    expect(send).toHaveBeenCalledOnce();
    const embed = (send.mock.calls[0]?.[0] as { embeds: { data: Record<string, unknown> }[] })
      .embeds[0]?.data;
    expect(embed).toMatchObject({ author: { name: 'replies:bug_report.from_admin' } });
    expect(embed?.footer).toBeUndefined();
    // Delivery is the normal case; only a failure is marked.
    expect(message.react).not.toHaveBeenCalled();
    expect(repo.setStatus).toHaveBeenCalledWith('bot', 7, 'in_progress');
  });

  it('marks a reply that could not reach the reporter', async () => {
    const { deps } = buildDeps(buildRepo(), { dmFails: true });
    const message = adminMessage('Can you send logs?');

    await relayAdminMessage(deps, message as never);

    expect(message.react).toHaveBeenCalledWith('⚠️');
  });

  it('keeps // notes in the post', async () => {
    const { deps, send } = buildDeps(buildRepo());
    await relayAdminMessage(deps, adminMessage('// checking logs') as never);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('reporter DMs', () => {
  it('goes to the only open ticket', async () => {
    const repo = buildRepo();
    repo.listOpenByReporter.mockResolvedValueOnce(ok([ticket()] as never[]));
    const { deps, thread } = buildDeps(repo);

    await relayReporterDm(deps, dm() as never);

    expect(thread.send).toHaveBeenCalledOnce();
  });

  it('asks which ticket when several are open', async () => {
    const repo = buildRepo();
    repo.listOpenByReporter.mockResolvedValueOnce(
      ok([ticket(), ticket({ number: 8, title: 'Another' })] as never[]),
    );
    const message = dm();

    await relayReporterDm(buildDeps(repo).deps, message as never);

    const reply = message.reply.mock.calls[0]?.[0] as { components: unknown[] };
    expect(reply.components).toHaveLength(1);
  });

  it('follows a reply to the bot DM, and refuses a closed ticket', async () => {
    const repo = buildRepo();
    repo.findByNumber.mockResolvedValueOnce(ok(ticket({ status: 'closed' }) as never));
    const message = dm({ reference: { messageId: 'bot-dm' } });
    message.channel.messages.fetch.mockResolvedValueOnce({
      author: { id: 'bot' },
      embeds: [{ author: { name: '#7 Admin Someone' } }],
    });

    await relayReporterDm(buildDeps(repo).deps, message as never);

    expect(repo.findByNumber).toHaveBeenCalledWith('bot', 7);
    expect(message.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'replies:bug_report.dm_ticket_closed' }),
    );
  });

  it('points a member without tickets at /bug_report', async () => {
    const message = dm();
    await relayReporterDm(buildDeps(buildRepo()).deps, message as never);
    expect(message.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'replies:bug_report.dm_no_ticket' }),
    );
  });
});
