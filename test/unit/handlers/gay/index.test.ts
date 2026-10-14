/** `/gay` always answers, never pings, and reads pairs when given a second member. */
import { describe, expect, it } from 'vitest';

import Gay from '../../../../src/handlers/commands/gay';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

const user = (id: string) => ({ id, displayName: `name-${id}` });

const run = async (second?: string) => {
  const sink = newInteractionSink();
  const interaction = buildChatInputInteraction({
    users: {
      user: user('u1'),
      ...(second === undefined ? {} : { user2: user(second) }),
    },
    sink,
  });
  // Neither member is cached: the reply must still go out. The builder
  // has no member resolver.
  Object.assign(interaction.options, { getMember: () => null });
  const { bot } = buildFakeBot({ timeZone: 'UTC' });
  await new Gay().execute(interaction, bot);
  return sink.replies[0];
};

describe('/gay', () => {
  it('answers a single reading for an uncached member without pinging', async () => {
    const sent = await run();

    expect(sent?.content).toMatch(/^replies:gay\.single\n> replies:gay\.single_/);
    expect(sent?.allowedMentions).toEqual({ parse: [] });
  });

  it('reads the pair when a second member is given', async () => {
    const sent = await run('u2');

    expect(sent?.content).toMatch(/^replies:gay\.pair\n> replies:gay\.pair_/);
  });
});
