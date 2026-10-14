/**
 * Handler-level tests for `handleGiveawayDeletePrompt`: instead of
 * asking for a message id, the command lists the guild's active
 * giveaways as a select menu. An empty list short-circuits to an
 * informational reply.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';

import { ok } from '../../../src/core/result';
import { handleGiveawayDeletePrompt } from '../../../src/handlers/commands/giveaway-shared/delete';
import { buildFakeBot, echoTranslatorWithParams } from '../../fixtures/discord/bot-fake';
import { buildGuild } from '../../fixtures/discord/guild-builder';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../fixtures/discord/interaction-builder';

const GUILD_ID = 'guild-1';

const makeRepos = (
  giveaways: ReadonlyArray<{
    message_id: string;
    prize: string;
    end_time: number;
    prize_owner_id?: string;
  }>,
) => ({
  giveaway: {
    listAll: vi.fn().mockResolvedValue(ok(giveaways)),
  },
});

const makeBot = (
  repos: ReturnType<typeof makeRepos>,
  extra: Readonly<Record<string, unknown>> = {},
) => {
  const getRepos = (guildId: string) => (guildId === GUILD_ID ? repos : undefined);
  return buildFakeBot({
    client: { guilds: { cache: new Map([[GUILD_ID, {}]]) } },
    getRepos,
    guildRegistry: {
      getRepos,
      getChannel: () => undefined,
      getRole: () => undefined,
      listGuildIds: () => [],
    },
    jobMap: new Map(),
    config: {},
    timeZone: 'UTC',
    isAdmin: () => false,
    ...extra,
  }).bot;
};

const makeInteraction = (manager = true) => {
  const sink = newInteractionSink();
  const interaction = buildChatInputInteraction({
    userId: 'owner-1',
    guild: buildGuild({ id: GUILD_ID }),
    memberPermissions: manager ? [PermissionFlagsBits.ManageMessages] : [],
    sink,
  });
  return { interaction, sink };
};

interface SelectRow {
  components: { options: { data: { value: string } }[] }[];
}

/** The option values of the select menu the prompt rendered into its first row. */
const offeredValues = (components: readonly unknown[] | undefined): string[] =>
  (components as SelectRow[] | undefined)?.[0]?.components[0]?.options.map(
    (option) => option.data.value,
  ) ?? [];

afterEach(() => vi.clearAllMocks());

describe('handleGiveawayDeletePrompt', () => {
  it('renders a select menu of active giveaways', async () => {
    const repos = makeRepos([
      { message_id: 'm1', prize: 'Nitro', end_time: 4_102_444_800_000 },
      { message_id: 'm2', prize: 'Game key', end_time: 4_102_444_800_000 },
    ]);
    const { interaction, sink } = makeInteraction();

    await handleGiveawayDeletePrompt(interaction, makeBot(repos));

    expect(sink.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    const reply = sink.editReplies[0];
    expect(reply?.content).toBe('replies:giveaway.delete_select_placeholder');
    // Two giveaways fit in a single 25-option select → exactly one row.
    expect(reply?.components).toHaveLength(1);
    expect(offeredValues(reply?.components)).toEqual(['m1', 'm2']);
  });

  it('replies that there are no active giveaways when the list is empty', async () => {
    const { interaction, sink } = makeInteraction();

    await handleGiveawayDeletePrompt(interaction, makeBot(makeRepos([])));

    expect(sink.editReplies).toEqual([{ content: 'replies:giveaway.no_active_giveaways' }]);
  });

  it('offers a member without moderation rights only their own giveaways', async () => {
    const repos = makeRepos([
      { message_id: 'm1', prize: 'Mine', end_time: 4_102_444_800_000, prize_owner_id: 'owner-1' },
      { message_id: 'm2', prize: 'Theirs', end_time: 4_102_444_800_000, prize_owner_id: 'x' },
    ]);
    const { interaction, sink } = makeInteraction(false);

    await handleGiveawayDeletePrompt(interaction, makeBot(repos));

    expect(offeredValues(sink.editReplies[0]?.components)).toEqual(['m1']);
  });
});

it('reports disabled database state with its trace ID', async () => {
  const bot = makeBot(makeRepos([]), {
    translator: echoTranslatorWithParams(),
    connectionManager: { isDisabled: () => ({ traceId: 'trace-db' }) },
  });
  const { interaction, sink } = makeInteraction();
  bot.guildRegistry.getRepos = () => undefined;

  await handleGiveawayDeletePrompt(interaction, bot);

  expect(sink.editReplies).toEqual([
    { content: 'errors:db.guild_disabled:{"traceId":"trace-db"}' },
  ]);
});
