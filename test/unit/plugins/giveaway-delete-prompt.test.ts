/**
 * Handler-level tests for `handleGiveawayDeletePrompt`: instead of
 * asking for a message id, the command lists the guild's active
 * giveaways as a select menu. An empty list short-circuits to an
 * informational reply.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';

import { ok } from '../../../src/core/result';
import { handleGiveawayDeletePrompt } from '../../../src/plugins/giveaway/internal/handlers';
import type { BaseBot } from '../../../src/bot';

const GUILD_ID = 'guild-1';

const translator = { t: (key: string) => key } as unknown as BaseBot['translator'];

const makeRepos = (
  giveaways: ReadonlyArray<{ message_id: string; prize: string; end_time: number }>,
) => ({
  giveaway: {
    listAll: vi.fn().mockResolvedValue(ok(giveaways)),
  },
});

const makeBot = (repos: ReturnType<typeof makeRepos>) =>
  ({
    client: { guilds: { cache: new Map([[GUILD_ID, {}]]) } },
    getRepos: (guildId: string) => (guildId === GUILD_ID ? repos : undefined),
    guildRegistry: {
      getRepos: (guildId: string) => (guildId === GUILD_ID ? repos : undefined),
      getChannel: () => undefined,
      getRole: () => undefined,
      listGuildIds: () => [],
    },
    jobMap: new Map(),
    requireLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
    translator,
  }) as unknown as BaseBot;

const makeInteraction = () =>
  ({
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    guild: { id: GUILD_ID },
  }) as unknown as ChatInputCommandInteraction;

afterEach(() => vi.clearAllMocks());

describe('handleGiveawayDeletePrompt', () => {
  it('renders a select menu of active giveaways', async () => {
    const repos = makeRepos([
      { message_id: 'm1', prize: 'Nitro', end_time: 4_102_444_800_000 },
      { message_id: 'm2', prize: 'Game key', end_time: 4_102_444_800_000 },
    ]);
    const bot = makeBot(repos);
    const interaction = makeInteraction();

    await handleGiveawayDeletePrompt(interaction, bot);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    const editReply = interaction.editReply as unknown as ReturnType<typeof vi.fn>;
    const arg = editReply.mock.calls[0]?.[0] as { components?: unknown[] };
    // Two giveaways fit in a single 25-option select → exactly one row.
    expect(arg.components).toHaveLength(1);
  });

  it('replies that there are no active giveaways when the list is empty', async () => {
    const repos = makeRepos([]);
    const bot = makeBot(repos);
    const interaction = makeInteraction();

    await handleGiveawayDeletePrompt(interaction, bot);

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'replies:giveaway.no_active_giveaways',
    });
  });
});

it('reports disabled database state with its trace ID', async () => {
  const repos = makeRepos([]);
  const bot = makeBot(repos);
  const interaction = makeInteraction();
  const translate = vi.fn((key: string) => key);
  Object.defineProperty(bot, 'translator', { value: { t: translate } });
  Object.defineProperty(bot, 'connectionManager', {
    value: { isDisabled: () => ({ traceId: 'trace-db' }) },
  });
  bot.guildRegistry.getRepos = () => undefined;
  await handleGiveawayDeletePrompt(interaction, bot);
  expect(translate).toHaveBeenCalledWith('errors:db.guild_disabled', { traceId: 'trace-db' });
  expect(interaction.editReply).toHaveBeenCalledWith({ content: 'errors:db.guild_disabled' });
});
