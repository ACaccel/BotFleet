/** `/reply list` answers privately and, without a keyword, lists every keyword. */
import { MessageFlags } from 'discord.js';
import { describe, expect, it } from 'vitest';

import ListReply from '../../../src/handlers/commands/list_reply/action';
import { ok } from '../../../src/core/result';
import { buildFakeBot, echoTranslatorWithParams } from '../../fixtures/discord/bot-fake';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../fixtures/discord/interaction-builder';

const pairs = [
  { input: 'hi', reply: 'hello' },
  { input: 'hi', reply: 'hey' },
  { input: 'bye', reply: 'see you' },
];

const run = async (options: Record<string, string>) => {
  const sink = newInteractionSink();
  const repos = {
    reply: {
      listAll: async () => ok(pairs),
      findByInput: async (input: string) => ok(pairs.filter((pair) => pair.input === input)),
    },
  };
  const { bot } = buildFakeBot({
    translator: echoTranslatorWithParams(),
    getRepos: () => repos,
  });
  await new ListReply().execute(buildChatInputInteraction({ sink, options }), bot);
  return sink;
};

describe('/reply list', () => {
  it('lists every keyword with its reply count, privately', async () => {
    const sink = await run({});

    expect(sink.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    const page = String(sink.editReplies[0]?.content);
    expect(page).toContain('> hi (2)');
    expect(page).toContain('> bye (1)');
  });

  it("lists one keyword's replies", async () => {
    const sink = await run({ keyword: 'hi' });

    const page = String(sink.editReplies[0]?.content);
    expect(page).toContain('> 1. hello');
    expect(page).toContain('> 2. hey');
    expect(page).not.toContain('see you');
  });

  it('answers not_found for an unknown keyword', async () => {
    const sink = await run({ keyword: 'nope' });

    expect(sink.editReplies[0]?.content).toContain('replies:list_reply.not_found');
  });
});
