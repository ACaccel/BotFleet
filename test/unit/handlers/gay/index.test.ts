/** `/gay` always answers, never pings, and reads pairs when given a second member. */
import { describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';

import Gay from '../../../../src/handlers/commands/gay';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';

const user = (id: string) => ({ id, displayName: `name-${id}` });

const run = async (second?: string) => {
  const reply = vi.fn(async (_options: unknown) => undefined);
  const interaction = {
    reply,
    options: {
      getUser: (name: string) => (name === 'user' ? user('u1') : second ? user(second) : null),
      // Neither member is cached: the reply must still go out.
      getMember: () => null,
    },
  } as unknown as ChatInputCommandInteraction;
  const { bot } = buildFakeBot({ timeZone: 'UTC' });
  await new Gay().execute(interaction, bot);
  return reply.mock.calls[0]?.[0] as { content: string; allowedMentions: unknown };
};

describe('/gay', () => {
  it('answers a single reading for an uncached member without pinging', async () => {
    const sent = await run();

    expect(sent.content).toMatch(/^replies:gay\.single\n> replies:gay\.single_/);
    expect(sent.allowedMentions).toEqual({ parse: [] });
  });

  it('reads the pair when a second member is given', async () => {
    const sent = await run('u2');

    expect(sent.content).toMatch(/^replies:gay\.pair\n> replies:gay\.pair_/);
  });
});
