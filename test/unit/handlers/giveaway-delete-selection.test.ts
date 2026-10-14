/**
 * Handler-level tests for `handleGiveawayDeleteSelection`: the selected
 * giveaway (carried as the select value) is deleted — its scheduled
 * draw job is cancelled and the document removed — and the invoker gets
 * an ephemeral confirmation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';

import { giveawayJobKey } from '../../../src/application/giveaway/giveaway';
import { ok } from '../../../src/core/result';
import { handleGiveawayDeleteSelection } from '../../../src/handlers/commands/giveaway-shared/delete';
import { buildFakeBot, echoTranslatorWithParams } from '../../fixtures/discord/bot-fake';
import { buildGuild } from '../../fixtures/discord/guild-builder';
import {
  buildStringSelectInteraction,
  newInteractionSink,
} from '../../fixtures/discord/interaction-builder';

const GUILD_ID = 'guild-1';
const MESSAGE_ID = 'm1';

/** In-memory giveaway repo so a test can read back what was deleted. */
const makeRepos = (ownerId = 'owner-1') => {
  const stored = new Map([
    [MESSAGE_ID, { message_id: MESSAGE_ID, prize_owner_id: ownerId, channel_id: 'chan-1' }],
  ]);
  return {
    stored,
    giveaway: {
      findByMessageId: async (id: string) => ok(stored.get(id) ?? null),
      deleteByMessageId: async (id: string) => ok(stored.delete(id)),
    },
  };
};

interface BotOptions {
  readonly knownGuild?: boolean;
  readonly jobMap?: Map<string, { cancel: () => void }>;
  readonly extra?: Readonly<Record<string, unknown>>;
}

const makeBot = (repos: ReturnType<typeof makeRepos>, options: BotOptions = {}) => {
  const bag = { giveaway: repos.giveaway };
  const getRepos = (guildId: string) => (guildId === GUILD_ID ? bag : undefined);
  const guilds =
    options.knownGuild === false
      ? new Map()
      : new Map([[GUILD_ID, { id: GUILD_ID, channels: { cache: new Map() } }]]);
  return buildFakeBot({
    client: { guilds: { cache: guilds }, channels: { fetch: async () => null } },
    isAdmin: () => false,
    getRepos,
    guildRegistry: {
      getRepos,
      getChannel: () => undefined,
      getRole: () => undefined,
      listGuildIds: () => [],
    },
    jobMap: options.jobMap ?? new Map(),
    ...options.extra,
  }).bot;
};

const makeInteraction = (values: string[], manager = false) => {
  const sink = newInteractionSink();
  const interaction = buildStringSelectInteraction({
    customId: 'giveaway_delete|0',
    values,
    userId: 'owner-1',
    guild: buildGuild({ id: GUILD_ID }),
    memberPermissions: manager ? [PermissionFlagsBits.ManageMessages] : [],
    sink,
  });
  return { interaction, sink };
};

afterEach(() => vi.clearAllMocks());

describe('handleGiveawayDeleteSelection', () => {
  it('deletes the selected giveaway, cancels its draw job and confirms', async () => {
    const repos = makeRepos();
    const cancel = vi.fn();
    const jobMap = new Map([[giveawayJobKey(MESSAGE_ID), { cancel }]]);
    const { interaction, sink } = makeInteraction([MESSAGE_ID]);

    await handleGiveawayDeleteSelection(interaction, makeBot(repos, { jobMap }));

    expect(sink.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(repos.stored.has(MESSAGE_ID)).toBe(false);
    // The scheduled draw would otherwise fire for a deleted giveaway.
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(jobMap.has(giveawayJobKey(MESSAGE_ID))).toBe(false);
    expect(sink.editReplies).toEqual([{ content: 'replies:giveaway.delete_success' }]);
  });

  it("refuses someone else's giveaway without moderation rights", async () => {
    const repos = makeRepos('someone-else');
    const { interaction, sink } = makeInteraction([MESSAGE_ID]);

    await handleGiveawayDeleteSelection(interaction, makeBot(repos));

    expect(repos.stored.has(MESSAGE_ID)).toBe(true);
    expect(sink.editReplies).toEqual([{ content: 'replies:giveaway.delete_forbidden' }]);
  });

  it("lets a moderator delete someone else's giveaway", async () => {
    const repos = makeRepos('someone-else');
    const { interaction, sink } = makeInteraction([MESSAGE_ID], true);

    await handleGiveawayDeleteSelection(interaction, makeBot(repos));

    expect(repos.stored.has(MESSAGE_ID)).toBe(false);
    expect(sink.editReplies).toEqual([{ content: 'replies:giveaway.delete_success' }]);
  });

  it('rejects when no giveaway was selected', async () => {
    const repos = makeRepos();
    const { interaction, sink } = makeInteraction([]);

    await handleGiveawayDeleteSelection(interaction, makeBot(repos));

    expect(repos.stored.has(MESSAGE_ID)).toBe(true);
    expect(sink.editReplies).toEqual([{ content: 'replies:giveaway.missing_message_id' }]);
  });

  it('answers a missing per-guild database with a catalog key, not a raw English reason', async () => {
    const repos = makeRepos();
    const bot = makeBot(repos);
    // Registered guild, no repos bag: the `no_db` outcome.
    bot.guildRegistry.getRepos = () => undefined;
    const { interaction, sink } = makeInteraction([MESSAGE_ID]);

    await handleGiveawayDeleteSelection(interaction, bot);

    // Previously the reply interpolated the literal 'Database not found'
    // into the localised template, so a zh-TW user saw English.
    expect(sink.editReplies).toEqual([{ content: 'errors:db.not_found' }]);
    expect(repos.stored.has(MESSAGE_ID)).toBe(true);
  });

  it('answers an unknown guild with the shared guild-not-found key', async () => {
    const repos = makeRepos();
    const { interaction, sink } = makeInteraction([MESSAGE_ID]);

    await handleGiveawayDeleteSelection(interaction, makeBot(repos, { knownGuild: false }));

    expect(sink.editReplies).toEqual([{ content: 'errors:command.guild_not_found' }]);
    expect(repos.stored.has(MESSAGE_ID)).toBe(true);
  });
});

it('reports disabled database state with its trace ID', async () => {
  const bot = makeBot(makeRepos(), {
    extra: {
      translator: echoTranslatorWithParams(),
      connectionManager: { isDisabled: () => ({ traceId: 'trace-db' }) },
    },
  });
  bot.guildRegistry.getRepos = () => undefined;
  const { interaction, sink } = makeInteraction([MESSAGE_ID]);

  await handleGiveawayDeleteSelection(interaction, bot);

  expect(sink.editReplies).toEqual([
    { content: 'errors:db.guild_disabled:{"traceId":"trace-db"}' },
  ]);
});
