/**
 * Handler-level tests for `handleGiveawayCreate` after the modal
 * redesign:
 *   - parameters arrive through modal text inputs (not slash options),
 *   - the giveaway is published in the channel the command was invoked
 *     from (no dedicated `giveaway` channel config),
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
import { MessageFlags, type ModalSubmitInteraction } from 'discord.js';

import { ok } from '../../../src/core/result';
import { handleGiveawayCreate } from '../../../src/plugins/giveaway/internal/handlers';
import type { BaseBot } from '../../../src/bot';

const GUILD_ID = 'guild-1';
const INVOKED_CHANNEL_ID = 'invoked-channel-1';
const MESSAGE_ID = 'msg-1';

const translator = { t: (key: string) => key } as unknown as BaseBot['translator'];

const makeChannel = (sendable: boolean) => ({
  id: INVOKED_CHANNEL_ID,
  isSendable: () => sendable,
  send: vi.fn().mockResolvedValue({ id: MESSAGE_ID, react: vi.fn().mockResolvedValue(undefined) }),
});

const makeRepos = () => ({
  giveaway: {
    create: vi.fn().mockResolvedValue(ok({ message_id: MESSAGE_ID })),
    findByMessageId: vi.fn().mockResolvedValue(ok({ message_id: MESSAGE_ID })),
    deleteByMessageId: vi.fn().mockResolvedValue(ok(true)),
  },
});

const makeBot = (
  repos: ReturnType<typeof makeRepos>,
  jobMap: Map<string, { cancel: () => void }>,
) =>
  ({
    client: { guilds: { cache: new Map([[GUILD_ID, {}]]) } },
    getRepos: (guildId: string) => (guildId === GUILD_ID ? repos : undefined),
    guildRegistry: {
      getRepos: (guildId: string) => (guildId === GUILD_ID ? repos : undefined),
      getChannel: () => undefined,
      getRole: () => undefined,
      listGuildIds: () => [],
    },
    jobMap,
    requireLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
    translator,
  }) as unknown as BaseBot;

type Fields = { duration: string; winner_num: string; prize: string; description: string };

const DEFAULT_FIELDS: Fields = {
  duration: '1d',
  winner_num: '1',
  prize: 'A Prize',
  description: 'desc',
};

const makeInteraction = (
  channel: ReturnType<typeof makeChannel>,
  fields: Fields = DEFAULT_FIELDS,
) =>
  ({
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    deleteReply: vi.fn().mockResolvedValue(undefined),
    guild: { id: GUILD_ID },
    channel,
    user: { id: 'user-1' },
    fields: {
      getTextInputValue: (name: keyof Fields) => fields[name] ?? '',
    },
  }) as unknown as ModalSubmitInteraction;

// node-schedule jobs created on the happy path are cancelled so no
// timer leaks past the test.
const scheduledJobs = new Map<string, { cancel: () => void }>();
afterEach(() => {
  for (const job of scheduledJobs.values()) job.cancel();
  scheduledJobs.clear();
  vi.clearAllMocks();
});

describe('handleGiveawayCreate (modal redesign)', () => {
  it('reads modal fields, publishes in interaction.channel, and stores that channel id', async () => {
    const repos = makeRepos();
    const channel = makeChannel(true);
    const bot = makeBot(repos, scheduledJobs);
    const interaction = makeInteraction(channel);

    await handleGiveawayCreate(interaction, bot);

    // Acknowledged ephemerally.
    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    // Announcement embed went to the channel the command was invoked in.
    expect(channel.send).toHaveBeenCalledTimes(1);
    // The invoking channel id is persisted so reboot re-resolves it.
    expect(repos.giveaway.create).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: INVOKED_CHANNEL_ID, message_id: MESSAGE_ID }),
    );
    // The interaction's own reply is removed; no success message remains.
    expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it('rejects ephemerally when winner_num is not a positive integer', async () => {
    const repos = makeRepos();
    const channel = makeChannel(true);
    const bot = makeBot(repos, scheduledJobs);
    const interaction = makeInteraction(channel, { ...DEFAULT_FIELDS, winner_num: 'abc' });

    await handleGiveawayCreate(interaction, bot);

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'replies:giveaway.invalid_winner_num',
    });
    expect(repos.giveaway.create).not.toHaveBeenCalled();
    expect(interaction.deleteReply).not.toHaveBeenCalled();
  });

  it('rejects ephemerally when required fields are blank', async () => {
    const repos = makeRepos();
    const channel = makeChannel(true);
    const bot = makeBot(repos, scheduledJobs);
    const interaction = makeInteraction(channel, { ...DEFAULT_FIELDS, prize: '   ' });

    await handleGiveawayCreate(interaction, bot);

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'replies:giveaway.missing_required_fields',
    });
    expect(repos.giveaway.create).not.toHaveBeenCalled();
  });

  it('rejects ephemerally when the invoking channel is not sendable', async () => {
    const repos = makeRepos();
    const channel = makeChannel(false);
    const bot = makeBot(repos, scheduledJobs);
    const interaction = makeInteraction(channel);

    await handleGiveawayCreate(interaction, bot);

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'errors:command.channel_not_found',
    });
    expect(repos.giveaway.create).not.toHaveBeenCalled();
    expect(interaction.deleteReply).not.toHaveBeenCalled();
  });
});

it('reports disabled database state with its trace ID', async () => {
  const repos = makeRepos();
  const channel = makeChannel(true);
  const bot = makeBot(repos, scheduledJobs);
  const interaction = makeInteraction(channel);
  const translate = vi.fn((key: string) => key);
  Object.defineProperty(bot, 'translator', { value: { t: translate } });
  Object.defineProperty(bot, 'connectionManager', {
    value: { isDisabled: () => ({ traceId: 'trace-db' }) },
  });
  bot.guildRegistry.getRepos = () => undefined;
  await handleGiveawayCreate(interaction, bot);
  expect(translate).toHaveBeenCalledWith('errors:db.guild_disabled', { traceId: 'trace-db' });
  expect(interaction.editReply).toHaveBeenCalledWith({ content: 'errors:db.guild_disabled' });
});
