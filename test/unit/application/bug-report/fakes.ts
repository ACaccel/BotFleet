/** Shared stand-ins for the bug-report service tests. */
import { ChannelType } from 'discord.js';
import { vi } from 'vitest';

import { ok } from '../../../../src/core/result';
import type { BugReportDeps } from '../../../../src/application/bug-report/tickets';

export const HUB = { guildId: '100000000000000001', channelId: '100000000000000002' };

export const ticket = (overrides: Record<string, unknown> = {}) => ({
  bot_id: 'bot',
  number: 7,
  reporter_id: 'reporter',
  type: 'bug',
  title: 'It broke',
  thread_id: 'thread-7',
  status: 'open',
  created_at: 0,
  ...overrides,
});

export const buildRepo = () => ({
  createNumbered: vi.fn(async () => ok(ticket())),
  setThread: vi.fn(async () => ok(undefined)),
  deleteByNumber: vi.fn(async () => ok(undefined)),
  findByNumber: vi.fn(async () => ok(ticket() as never)),
  findByThread: vi.fn(async () => ok(ticket() as never)),
  listOpenByReporter: vi.fn(async () => ok([] as never[])),
  lastCreatedAt: vi.fn(async () => ok(undefined as number | undefined)),
  setStatus: vi.fn(async () => ok(undefined)),
  markDmFailed: vi.fn(async () => ok(undefined)),
});

export const buildDeps = (
  repo: ReturnType<typeof buildRepo>,
  { dmFails = false, permissions = true } = {},
) => {
  const thread = {
    id: 'thread-7',
    send: vi.fn(async () => undefined),
    isThread: () => true,
    parent: { type: ChannelType.GuildForum, availableTags: [] },
    setAppliedTags: vi.fn(async () => undefined),
    setLocked: vi.fn(async () => undefined),
    setArchived: vi.fn(async () => undefined),
  };
  const forum = {
    type: ChannelType.GuildForum,
    availableTags: [
      { id: 'tag-bug', name: 'Bug' },
      { id: 'tag-open', name: 'Open' },
    ],
    threads: { create: vi.fn(async (_options: unknown) => thread) },
    permissionsFor: () => ({ has: () => permissions }),
    guild: { members: { fetchMe: vi.fn(async () => ({ id: 'bot' })) } },
  };
  const send = vi.fn(async (_options: unknown) => {
    if (dmFails) throw new Error('Cannot send messages to this user');
  });
  const deps = {
    client: {
      user: { id: 'bot' },
      channels: { fetch: vi.fn(async (id: string) => (id === HUB.channelId ? forum : thread)) },
      users: { fetch: vi.fn(async () => ({ send })) },
    },
    tickets: async () => repo,
    botId: 'bot',
    botLabel: 'Nijika',
    config: { hub: HUB, tags: { bug: 'Bug', open: 'Open' } },
    translator: { t: (key: string) => key },
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    isAdmin: () => false,
  } as unknown as BugReportDeps;
  return { deps, forum, thread, send };
};
