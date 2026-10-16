import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageContextMenuCommandInteraction } from 'discord.js';

import MenuGiveScore from '../../../../src/handlers/commands/menu_give_score';
import { scoreFor } from '../../../../src/handlers/commands/give_score/score';
import { buildFakeBot, echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';

const NOW = Date.UTC(2026, 9, 14, 18);
const PERSONA = 'Nijika';
const URL = 'https://discord.com/channels/g-1/c-1/m-1';

const run = async (member: { displayName: string } | null, messageId = 'm-1') => {
  const reply = vi.fn(async (_payload: { content: string; allowedMentions: unknown }) => undefined);
  const interaction = {
    targetMessage: {
      id: messageId,
      url: URL,
      member,
      author: { id: 'author-1', displayName: 'Global name' },
    },
    reply,
  } as unknown as MessageContextMenuCommandInteraction;
  const { bot } = buildFakeBot({
    timeZone: 'UTC',
    personaName: PERSONA,
    translator: echoTranslatorWithParams(),
  });
  await new MenuGiveScore().execute(interaction, bot);
  return reply.mock.calls[0]?.[0];
};

const expected = (author: string, messageId = 'm-1') => {
  const { score, commentKey } = scoreFor(`message:${messageId}`, 'UTC', Date.now());
  return `replies:give_score.message_result:${JSON.stringify({ persona: PERSONA, author, url: URL, score })}\n> ${commentKey}`;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => vi.useRealTimers());

describe('menu_give_score', () => {
  it('scores the message by id and links it under the author server name', async () => {
    const payload = await run({ displayName: 'Server name' });

    expect(payload).toEqual({ content: expected('Server name'), allowedMentions: { parse: [] } });
  });

  it('falls back to the author global name outside a guild', async () => {
    const payload = await run(null);

    expect(payload?.content).toBe(expected('Global name'));
  });

  it('scores a message apart from its author', () => {
    // Different seeds, so a message and its author are rated independently.
    expect(scoreFor('message:m-1', 'UTC', NOW)).not.toEqual(scoreFor('author-1', 'UTC', NOW));
  });
});
