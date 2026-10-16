import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import GiveScore from '../../../../src/handlers/commands/give_score';
import { scoreFor } from '../../../../src/handlers/commands/give_score/score';
import { localizeCommandConfig } from '../../../../src/handlers/commands/command';
import { buildCommandJsonBody } from '../../../../src/handlers/commands/command-builder';
import { buildFakeBot, echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';
import { buildGuildMember } from '../../../fixtures/discord/member-builder';

const NOW = Date.UTC(2026, 9, 14, 18);
const INVOKER_ID = 'invoker-1';
const USER_ID = 'scored-user';
const PERSONA = 'Nijika';

interface Input {
  readonly subject?: string;
  readonly user?: { readonly id: string; readonly displayName: string };
  readonly member?: { readonly displayName: string } | { readonly nick: string } | null;
  readonly invokerMember?: { readonly displayName: string } | null;
  readonly timeZone?: string;
}

const run = async ({
  subject,
  user,
  member = null,
  invokerMember = null,
  timeZone = 'UTC',
}: Input = {}) => {
  const sink = newInteractionSink();
  const interaction = buildChatInputInteraction({
    commandName: 'give_score',
    userId: INVOKER_ID,
    options: subject === undefined ? {} : { subject },
    users: user === undefined ? {} : { user },
    member:
      invokerMember === null ? null : buildGuildMember({ displayName: invokerMember.displayName }),
    sink,
  });
  // The builder has no member resolver; the scored member is cached or not.
  Object.assign(interaction.options, { getMember: () => member });
  const { bot } = buildFakeBot({
    timeZone,
    personaName: PERSONA,
    translator: echoTranslatorWithParams(),
  });

  await new GiveScore().execute(interaction, bot);

  return sink;
};

const expectedContent = (seed: string, name: string, timeZone = 'UTC') => {
  const { score, commentKey } = scoreFor(seed, timeZone, Date.now());
  return `replies:give_score.result:${JSON.stringify({ persona: PERSONA, subject: name, score })}\n> ${commentKey}`;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => vi.useRealTimers());

describe('/give_score', () => {
  it('registers optional subject and user inputs', () => {
    const { bot } = buildFakeBot();
    const body = buildCommandJsonBody(
      localizeCommandConfig(new GiveScore().config, bot.translator),
    );
    expect(body.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'subject', type: 3, required: false, max_length: 100 }),
        expect.objectContaining({ name: 'user', type: 6, required: false }),
      ]),
    );
  });

  it('scores the invoker by user ID with their guild display name when no option is supplied', async () => {
    const sink = await run({ invokerMember: { displayName: 'Guild nickname' } });
    expect(sink.replies).toEqual([
      {
        content: expectedContent(INVOKER_ID, 'Guild nickname'),
        allowedMentions: { parse: [] },
      },
    ]);
    expect(sink.defers).toEqual([]);
  });

  it('uses the invoker user display name when no guild member is available', async () => {
    const sink = await run();
    expect(sink.replies[0]?.content).toBe(expectedContent(INVOKER_ID, 'tester'));
  });

  it('scores a free-text subject when no user is chosen', async () => {
    const sink = await run({ subject: 'Dinner', invokerMember: { displayName: 'Guild nickname' } });
    expect(sink.replies[0]?.content).toBe(expectedContent('Dinner', 'Dinner'));
  });

  it('gives the selected user priority over free text and the invoking member', async () => {
    const sink = await run({
      subject: 'Ignored subject',
      user: { id: USER_ID, displayName: 'Global display name' },
      member: { displayName: 'Target nickname' },
      invokerMember: { displayName: 'Invoker nickname' },
    });
    expect(sink.replies[0]?.content).toBe(expectedContent(USER_ID, 'Target nickname'));
    expect(sink.replies[0]?.content).not.toContain('Ignored subject');
    expect(sink.replies[0]?.content).not.toContain('Invoker nickname');
  });

  it('scores an uncached selected user without requiring a guild member', async () => {
    const sink = await run({ user: { id: USER_ID, displayName: 'Uncached global name' } });
    expect(sink.replies[0]?.content).toBe(expectedContent(USER_ID, 'Uncached global name'));
  });

  it('uses the global display name when a resolved API member has no displayName', async () => {
    const sink = await run({
      user: { id: USER_ID, displayName: 'Global display name' },
      member: { nick: 'Raw API member' },
    });
    expect(sink.replies[0]?.content).toBe(expectedContent(USER_ID, 'Global display name'));
  });

  it('uses the bot time zone for the daily score and repeats the same result within that day', async () => {
    const input = { user: { id: USER_ID, displayName: 'Target' }, timeZone: 'Asia/Taipei' };
    const expected = expectedContent(USER_ID, 'Target', 'Asia/Taipei');
    expect(scoreFor(USER_ID, 'Asia/Taipei', NOW)).not.toEqual(scoreFor(USER_ID, 'UTC', NOW));
    const first = await run(input);
    expect(first.replies[0]?.content).toBe(expected);
    vi.setSystemTime(NOW + 3_600_000);
    const repeated = await run(input);
    expect(repeated.replies).toEqual(first.replies);
  });

  it('disables all mentions even when free text contains role and everyone mentions', async () => {
    const subject = '@everyone <@&123456789012345678>';
    const sink = await run({ subject });
    expect(sink.replies).toEqual([
      { content: expectedContent(subject, subject), allowedMentions: { parse: [] } },
    ]);
  });
});
