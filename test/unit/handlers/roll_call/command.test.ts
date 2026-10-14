/** `/roll_call` refuses unusable input before posting anything. */
import { describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';

import RollCall from '../../../../src/handlers/commands/roll_call';
import { ok } from '../../../../src/core/result';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';

const run = async (options: Record<string, string>, activityDoc?: unknown) => {
  const editReply = vi.fn(async (_options: unknown) => undefined);
  const send = vi.fn();
  const interaction = {
    deferReply: vi.fn(async () => undefined),
    editReply,
    deferred: true,
    replied: false,
    guildId: 'g1',
    guild: {
      id: 'g1',
      channels: { cache: new Map([['c1', { permissionsFor: () => ({ has: () => false }) }]]) },
    },
    channel: { id: 'c9', isSendable: () => true, send },
    user: { id: 'caller' },
    options: { get: (name: string) => (name in options ? { value: options[name] } : null) },
  } as unknown as ChatInputCommandInteraction;
  const { bot } = buildFakeBot({
    getRepos: () => ({ activity: { findByActivityId: async () => ok(activityDoc) } }),
  });
  await new RollCall().execute(interaction, bot);
  return { send, content: (editReply.mock.calls[0]?.[0] as { content: string }).content };
};

describe('/roll_call', () => {
  it('asks for someone to call', async () => {
    const { send, content } = await run({});
    expect(content).toBe('replies:roll_call.missing_target');
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a deadline outside 1 minute to 1 day', async () => {
    expect((await run({ users: '<@1>', deadline: '2d' })).content).toBe(
      'replies:roll_call.invalid_deadline',
    );
  });

  it('does not reveal an activity in a channel the caller cannot see', async () => {
    const hidden = { activity_id: 'a1', channel_id: 'c1', participants: ['u1'], status: 'open' };
    expect((await run({ activity: 'a1' }, hidden)).content).toBe(
      'replies:roll_call.activity_not_found',
    );
  });
});
