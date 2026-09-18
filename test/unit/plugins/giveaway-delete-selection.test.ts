/**
 * Handler-level tests for `handleGiveawayDeleteSelection`: the selected
 * giveaway (carried as the select value) is deleted — its scheduled
 * draw job is cancelled and the document removed — and the invoker gets
 * an ephemeral confirmation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageFlags, type StringSelectMenuInteraction } from 'discord.js';

import { ok } from '../../../src/core/result';
import { handleGiveawayDeleteSelection } from '../../../src/plugins/giveaway/internal/handlers';
import type { BaseBot } from '../../../src/bot';

const GUILD_ID = 'guild-1';
const MESSAGE_ID = 'm1';

const translator = { t: (key: string) => key } as unknown as BaseBot['translator'];

const makeRepos = () => ({
  giveaway: {
    deleteByMessageId: vi.fn().mockResolvedValue(ok(true)),
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

const makeInteraction = (values: string[]) =>
  ({
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    guild: { id: GUILD_ID },
    values,
  }) as unknown as StringSelectMenuInteraction;

afterEach(() => vi.clearAllMocks());

describe('handleGiveawayDeleteSelection', () => {
  it('deletes the selected giveaway and confirms', async () => {
    const repos = makeRepos();
    const bot = makeBot(repos);
    const interaction = makeInteraction([MESSAGE_ID]);

    await handleGiveawayDeleteSelection(interaction, bot);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(repos.giveaway.deleteByMessageId).toHaveBeenCalledWith(MESSAGE_ID);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'replies:giveaway.delete_success',
    });
  });

  it('rejects when no giveaway was selected', async () => {
    const repos = makeRepos();
    const bot = makeBot(repos);
    const interaction = makeInteraction([]);

    await handleGiveawayDeleteSelection(interaction, bot);

    expect(repos.giveaway.deleteByMessageId).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'replies:giveaway.missing_message_id',
    });
  });

  it('answers a missing per-guild database with a catalog key, not a raw English reason', async () => {
    const repos = makeRepos();
    const bot = makeBot(repos);
    // Registered guild, no repos bag: the `no_db` outcome.
    (bot as unknown as { guildRegistry: { getRepos: () => undefined } }).guildRegistry.getRepos =
      () => undefined;
    const interaction = makeInteraction([MESSAGE_ID]);

    await handleGiveawayDeleteSelection(interaction, bot);

    // Previously the reply interpolated the literal 'Database not found'
    // into the localised template, so a zh-TW user saw English.
    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'errors:db.not_found' });
  });

  it('answers an unknown guild with the shared guild-not-found key', async () => {
    const repos = makeRepos();
    const bot = makeBot(repos);
    (bot as unknown as { client: { guilds: { cache: Map<string, unknown> } } }).client = {
      guilds: { cache: new Map() },
    };
    const interaction = makeInteraction([MESSAGE_ID]);

    await handleGiveawayDeleteSelection(interaction, bot);

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'errors:command.guild_not_found',
    });
  });
});

it('reports disabled database state with its trace ID', async () => {
  const repos = makeRepos();
  const bot = makeBot(repos);
  const interaction = makeInteraction([MESSAGE_ID]);
  const translate = vi.fn((key: string) => key);
  Object.defineProperty(bot, 'translator', { value: { t: translate } });
  Object.defineProperty(bot, 'connectionManager', {
    value: { isDisabled: () => ({ traceId: 'trace-db' }) },
  });
  bot.guildRegistry.getRepos = () => undefined;
  await handleGiveawayDeleteSelection(interaction, bot);
  expect(translate).toHaveBeenCalledWith('errors:db.guild_disabled', { traceId: 'trace-db' });
  expect(interaction.editReply).toHaveBeenCalledWith({ content: 'errors:db.guild_disabled' });
});
