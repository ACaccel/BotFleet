/**
 * Handler-level tests for `handleGiveawayCreate` after the modal
 * redesign:
 *   - parameters arrive through modal text inputs (not slash options),
 *   - the giveaway is published in the channel the command was invoked
 *     from unless the configured giveaway channel is selected,
 *   - `winner_num` is parsed/validated server-side (modals have no
 *     numeric input type), and
 *   - the interaction's own reply is removed on success (the
 *     announcement embed is the only visible output).
 *
 * The handler imports `BaseBot` type-only, so this test needs no handler
 * registry mocks — it constructs minimal fakes for the interaction, bot,
 * channel and repos.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageFlags, type Channel } from 'discord.js';

import { ok } from '../../../src/core/result';
import { handleGiveawayCreate } from '../../../src/handlers/commands/giveaway-shared/create';
import { buildFakeBot, echoTranslatorWithParams } from '../../fixtures/discord/bot-fake';
import { buildSendableChannel } from '../../fixtures/discord/channel-builder';
import { buildGuild } from '../../fixtures/discord/guild-builder';
import {
  buildModalSubmitInteraction,
  newInteractionSink,
} from '../../fixtures/discord/interaction-builder';

const GUILD_ID = 'guild-1';
const INVOKED_CHANNEL_ID = 'invoked-channel-1';
const MESSAGE_ID = 'msg-1';

const makeChannel = (sendable: boolean, id = INVOKED_CHANNEL_ID) => {
  const fake = buildSendableChannel({ id, sendable, messageId: MESSAGE_ID });
  const react = vi.fn().mockResolvedValue(undefined);
  const deleteAnnouncement = vi.fn().mockResolvedValue(undefined);
  Object.assign(fake.message, { react });
  Object.assign(fake.channel, { messages: { delete: deleteAnnouncement } });
  return { ...fake, react, deleteAnnouncement };
};

const makeRepos = () => ({
  giveaway: {
    create: vi.fn().mockResolvedValue(ok({ message_id: MESSAGE_ID })),
    findByMessageId: vi.fn().mockResolvedValue(ok({ message_id: MESSAGE_ID })),
    deleteByMessageId: vi.fn().mockResolvedValue(ok(true)),
  },
});

interface BotOptions {
  /** What `guildRegistry.getChannel` resolves for the configured giveaway channel. */
  readonly configuredChannel?: Channel;
  readonly connectionManager?: unknown;
}

const makeBot = (
  repos: ReturnType<typeof makeRepos>,
  jobMap: Map<string, { cancel: () => void }>,
  options: BotOptions = {},
) => {
  const getChannel = vi.fn(() => options.configuredChannel);
  const getRepos = (guildId: string) => (guildId === GUILD_ID ? repos : undefined);
  const { bot, logger } = buildFakeBot({
    client: { guilds: { cache: new Map([[GUILD_ID, {}]]) } },
    getRepos,
    guildRegistry: {
      getRepos,
      getChannel,
      getRole: () => undefined,
      listGuildIds: () => [],
    },
    jobMap,
    translator: echoTranslatorWithParams(),
    ...(options.connectionManager === undefined
      ? {}
      : { connectionManager: options.connectionManager }),
  });
  return { bot, logger, getChannel };
};

type Fields = { duration: string; winner_num: string; prize: string; description: string };

const DEFAULT_FIELDS: Fields = {
  duration: '1d',
  winner_num: '1',
  prize: 'A Prize',
  description: 'desc',
};

const makeInteraction = (
  channel: Channel,
  fields: Fields = DEFAULT_FIELDS,
  customId = 'giveaway_create',
) => {
  const sink = newInteractionSink();
  const interaction = buildModalSubmitInteraction({
    customId,
    userId: 'user-1',
    guild: buildGuild({ id: GUILD_ID }),
    channel,
    textInputs: fields,
    sink,
  });
  return { interaction, sink };
};

// node-schedule jobs created on the happy path are cancelled so no
// timer leaks past the test.
const scheduledJobs = new Map<string, { cancel: () => void }>();
afterEach(() => {
  for (const job of scheduledJobs.values()) job.cancel();
  scheduledJobs.clear();
  vi.clearAllMocks();
});

describe('handleGiveawayCreate (modal redesign)', () => {
  it('checks the configured destination scope before publishing', async () => {
    const source = makeChannel(true);
    const destination = makeChannel(true, 'configured-destination');
    const repos = makeRepos();
    const { bot } = makeBot(repos, new Map(), { configuredChannel: destination.channel });
    const isEnabled = vi.fn(() => false);
    Object.assign(bot, { guildSettings: { isEnabled } });
    const { interaction, sink } = makeInteraction(
      source.channel,
      DEFAULT_FIELDS,
      'giveaway_create|configured',
    );
    await handleGiveawayCreate(interaction, bot);
    expect(isEnabled).toHaveBeenCalledWith(GUILD_ID, 'giveaways', 'configured-destination', []);
    expect(destination.send).not.toHaveBeenCalled();
    expect(repos.giveaway.create).not.toHaveBeenCalled();
    expect(sink.editReplies[0]?.content).toContain('replies:settings.feature_disabled');
  });
  it('reads modal fields, publishes in interaction.channel, and stores that channel id', async () => {
    const repos = makeRepos();
    const channel = makeChannel(true);
    const { bot } = makeBot(repos, scheduledJobs);
    const { interaction, sink } = makeInteraction(channel.channel);

    await handleGiveawayCreate(interaction, bot);

    // Acknowledged ephemerally.
    expect(sink.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    // Announcement embed went to the channel the command was invoked in,
    // carrying the modal's prize and winner count.
    expect(channel.send).toHaveBeenCalledTimes(1);
    const embed = channel.send.mock.calls[0]?.[0].embeds[0].toJSON();
    expect(embed.color).toBe(0x9b59b6);
    expect(embed.title).toBe('replies:giveaway.announce_title:{"prize":"A Prize"}');
    expect(embed.fields.map((f: { value: string }) => f.value)).toContain('1');
    expect(embed.fields.map((f: { value: string }) => f.value)).toContain('<@user-1>');
    // The announcement is reacted to so participants can enter.
    expect(channel.react).toHaveBeenCalledWith('🎉');
    // The invoking channel id is persisted so reboot re-resolves it.
    expect(repos.giveaway.create).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: INVOKED_CHANNEL_ID,
        message_id: MESSAGE_ID,
        prize: 'A Prize',
        winner_num: 1,
        prize_owner_id: 'user-1',
      }),
    );
    // The draw is scheduled under the announcement's key.
    expect(scheduledJobs.size).toBe(1);
    // The interaction's own reply is removed; no success message remains.
    expect(sink.deletes).toEqual(['@original']);
    expect(sink.editReplies).toEqual([]);
  });

  it('publishes in the configured channel and persists it', async () => {
    const repos = makeRepos();
    const current = makeChannel(false);
    const configured = makeChannel(true, 'configured-channel');
    const { bot, getChannel } = makeBot(repos, scheduledJobs, {
      configuredChannel: configured.channel,
    });
    const { interaction, sink } = makeInteraction(
      current.channel,
      DEFAULT_FIELDS,
      'giveaway_create|configured',
    );

    await handleGiveawayCreate(interaction, bot);

    expect(getChannel).toHaveBeenCalledWith(GUILD_ID, 'giveaway');
    expect(configured.send).toHaveBeenCalledTimes(1);
    expect(current.send).not.toHaveBeenCalled();
    expect(repos.giveaway.create).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: 'configured-channel' }),
    );
    expect(sink.deletes).toEqual(['@original']);
    expect(sink.editReplies).toEqual([]);
  });

  it.each(['missing', 'not-sendable'] as const)(
    'does not fall back when the configured channel is %s',
    async (state) => {
      const repos = makeRepos();
      const current = makeChannel(true);
      const { bot } = makeBot(repos, scheduledJobs, {
        configuredChannel: state === 'missing' ? undefined : makeChannel(false).channel,
      });
      const { interaction, sink } = makeInteraction(
        current.channel,
        DEFAULT_FIELDS,
        'giveaway_create|configured',
      );

      await handleGiveawayCreate(interaction, bot);

      expect(current.send).not.toHaveBeenCalled();
      expect(repos.giveaway.create).not.toHaveBeenCalled();
      expect(sink.editReplies).toEqual([{ content: 'errors:command.channel_not_found' }]);
    },
  );

  it('rejects ephemerally when winner_num is not a positive integer', async () => {
    const repos = makeRepos();
    const channel = makeChannel(true);
    const { bot } = makeBot(repos, scheduledJobs);
    const { interaction, sink } = makeInteraction(channel.channel, {
      ...DEFAULT_FIELDS,
      winner_num: 'abc',
    });

    await handleGiveawayCreate(interaction, bot);

    expect(sink.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(sink.editReplies).toEqual([{ content: 'replies:giveaway.invalid_winner_num' }]);
    expect(repos.giveaway.create).not.toHaveBeenCalled();
    expect(sink.deletes).toEqual([]);
  });

  it.each(['30s', '31d'])('rejects a %s duration outside 1 minute to 30 days', async (duration) => {
    const repos = makeRepos();
    const channel = makeChannel(true);
    const { interaction, sink } = makeInteraction(channel.channel, {
      ...DEFAULT_FIELDS,
      duration,
    });

    await handleGiveawayCreate(interaction, makeBot(repos, scheduledJobs).bot);

    expect(sink.editReplies).toEqual([{ content: 'replies:giveaway.invalid_duration' }]);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('withdraws the announcement when the record cannot be stored', async () => {
    const repos = makeRepos();
    repos.giveaway.create.mockResolvedValueOnce({ ok: false, error: new Error('db down') });
    const channel = makeChannel(true);
    const { interaction, sink } = makeInteraction(channel.channel);
    const { bot, logger } = makeBot(repos, scheduledJobs);

    await handleGiveawayCreate(interaction, bot);

    expect(channel.deleteAnnouncement).toHaveBeenCalledWith(MESSAGE_ID);
    expect(sink.editReplies).toEqual([{ content: 'replies:giveaway.create_failed' }]);
    expect(logger.error).toHaveBeenCalled();
    // A giveaway that was never stored must not be scheduled for a draw.
    expect(scheduledJobs.size).toBe(0);
  });

  it('rejects ephemerally when required fields are blank', async () => {
    const repos = makeRepos();
    const channel = makeChannel(true);
    const { bot } = makeBot(repos, scheduledJobs);
    const { interaction, sink } = makeInteraction(channel.channel, {
      ...DEFAULT_FIELDS,
      prize: '   ',
    });

    await handleGiveawayCreate(interaction, bot);

    expect(sink.editReplies).toEqual([{ content: 'replies:giveaway.missing_required_fields' }]);
    expect(repos.giveaway.create).not.toHaveBeenCalled();
  });

  it('rejects ephemerally when the invoking channel is not sendable', async () => {
    const repos = makeRepos();
    const channel = makeChannel(false);
    const { bot } = makeBot(repos, scheduledJobs);
    const { interaction, sink } = makeInteraction(channel.channel);

    await handleGiveawayCreate(interaction, bot);

    expect(sink.editReplies).toEqual([{ content: 'errors:command.channel_not_found' }]);
    expect(repos.giveaway.create).not.toHaveBeenCalled();
    expect(sink.deletes).toEqual([]);
  });
});

it('reports disabled database state with its trace ID', async () => {
  const repos = makeRepos();
  const channel = makeChannel(true);
  const { bot } = makeBot(repos, scheduledJobs, {
    connectionManager: { isDisabled: () => ({ traceId: 'trace-db' }) },
  });
  const { interaction, sink } = makeInteraction(channel.channel);
  bot.guildRegistry.getRepos = () => undefined;

  await handleGiveawayCreate(interaction, bot);

  expect(sink.editReplies).toEqual([
    { content: 'errors:db.guild_disabled:{"traceId":"trace-db"}' },
  ]);
});
