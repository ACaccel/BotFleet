import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageContextMenuCommandInteraction } from 'discord.js';

import MenuGiveScore from '../../../../src/handlers/commands/menu_give_score';
import { scoreFor } from '../../../../src/handlers/commands/give_score/score';
import { buildFakeBot, echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';

const NOW = Date.UTC(2026, 9, 14, 18);
const PERSONA = 'Nijika';
const URL = 'https://discord.com/channels/g-1/c-1/m-1';

const run = async (
  member: { displayName: string } | null,
  messageId = 'm-1',
  content = 'Original message',
) => {
  const reply = vi.fn(async (_payload: { content: string; allowedMentions: unknown }) => undefined);
  const interaction = {
    targetMessage: {
      id: messageId,
      url: URL,
      content,
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

const expected = (author: string, messageId = 'm-1', preview = 'Original message') => {
  const { score, commentKey } = scoreFor(`message:${messageId}`, 'UTC', Date.now());
  return `replies:give_score.message_result:${JSON.stringify({ persona: PERSONA, author, preview, url: URL, score })}\n> ${commentKey}`;
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

  it('uses the original message text with whitespace collapsed as the link label', async () => {
    const payload = await run(null, 'm-1', '  First line\n\nsecond\tline  ');

    expect(payload?.content).toBe(expected('Global name', 'm-1', 'First line second line'));
  });

  it.each([
    ['a'.repeat(100), 'a'.repeat(100)],
    ['a'.repeat(101), `${'a'.repeat(99)}…`],
    ['👨‍👩‍👧'.repeat(101), `${'👨‍👩‍👧'.repeat(99)}…`],
    ['e\u0301'.repeat(101), `${'e\u0301'.repeat(99)}…`],
  ])('bounds the preview without splitting characters (%#)', async (content, preview) => {
    const payload = await run(null, 'm-1', content);

    expect(payload?.content).toBe(expected('Global name', 'm-1', preview));
  });

  it.each([
    ['**bold**', '\\*\\*bold\\*\\*'],
    ['[label](https://example.com)', '\\[label\\](https://example.com)'],
    ['](https://example.com) [', '\\](https://example.com) \\['],
    ['\\]', '\\\\\\]'],
  ])('escapes formatting and brackets in the link label (%#)', async (content, preview) => {
    const payload = await run(null, 'm-1', content);

    expect(payload?.content).toBe(expected('Global name', 'm-1', preview));
    expect(payload?.allowedMentions).toEqual({ parse: [] });
  });

  it.each(['', ' \n\t '])(
    'keeps a localized link label for messages without text (%#)',
    async (content) => {
      const payload = await run(null, 'm-1', content);

      expect(payload?.content).toBe(
        expected('Global name', 'm-1', 'replies:give_score.message_empty'),
      );
    },
  );

  it('scores a message apart from its author', () => {
    // Different seeds, so a message and its author are rated independently.
    expect(scoreFor('message:m-1', 'UTC', NOW)).not.toEqual(scoreFor('author-1', 'UTC', NOW));
  });
});
