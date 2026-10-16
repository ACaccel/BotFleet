/** `/roll_call` refuses unusable input before posting anything. */
import { describe, expect, it, vi } from 'vitest';

import RollCall from '../../../../src/handlers/commands/roll_call';
import { ok } from '../../../../src/core/result';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import { buildTextChannel } from '../../../fixtures/discord/channel-builder';
import { buildGuild } from '../../../fixtures/discord/guild-builder';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

const run = async (options: Record<string, string>, activityDoc?: unknown) => {
  const send = vi.fn();
  const channel = { id: 'c9', isSendable: () => true, send };
  const sink = newInteractionSink();
  const interaction = buildChatInputInteraction({
    userId: 'caller',
    // The caller cannot see c1, so an activity posted there stays hidden.
    guild: buildGuild({
      id: 'g1',
      channels: [buildTextChannel({ id: 'c1', permissionsBySubject: {} })],
    }),
    channel,
    options,
    sink,
  });
  const { bot } = buildFakeBot({
    getRepos: () => ({ activity: { findByActivityId: async () => ok(activityDoc) } }),
  });
  await new RollCall().execute(interaction, bot);
  return { send, sink, content: sink.editReplies[0]?.content };
};

describe('/roll_call', () => {
  it('asks for someone to call', async () => {
    const { send, content } = await run({});
    expect(content).toBe('replies:roll_call.missing_target');
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a deadline outside 1 minute to 1 day', async () => {
    const { content, send } = await run({ users: '<@1>', deadline: '2d' });
    expect(content).toBe('replies:roll_call.invalid_deadline');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not reveal an activity in a channel the caller cannot see', async () => {
    const hidden = { activity_id: 'a1', channel_id: 'c1', participants: ['u1'], status: 'open' };
    const { content, send } = await run({ activity: 'a1' }, hidden);
    expect(content).toBe('replies:roll_call.activity_not_found');
    expect(send).not.toHaveBeenCalled();
  });
});
