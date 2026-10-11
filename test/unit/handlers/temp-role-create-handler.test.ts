/**
 * Handler-level tests for `handleTempRoleCreate`.
 *
 * The handler imports `BaseBot` type-only, so this test constructs
 * minimal fakes for the interaction, bot, guild, channel and repos —
 * no handler-registry or real Discord wiring.
 */
import type { Job } from 'node-schedule';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MessageFlags,
  type Channel,
  type ChatInputCommandInteraction,
  type Guild,
} from 'discord.js';

import { ok } from '../../../src/core/result';
import { handleTempRoleCreate } from '../../../src/handlers/commands/temp_role/create';
import type { BaseBot } from '../../../src/bot';
import { buildFakeBot } from '../../fixtures/discord/bot-fake';
import { buildGuild, buildGuildRoles } from '../../fixtures/discord/guild-builder';
import { buildSendableChannel } from '../../fixtures/discord/channel-builder';

const GUILD_ID = 'guild-1';

const makeRepos = () => ({
  tempRole: {
    create: vi.fn().mockResolvedValue(ok({ role_id: 'role-1' })),
    findByRoleId: vi.fn().mockResolvedValue(ok(undefined)),
    deleteByRoleId: vi.fn().mockResolvedValue(ok(true)),
    listAll: vi.fn().mockResolvedValue(ok([])),
  },
});

/** Guild plus its role spies, so assertions skip the Discord type. */
const makeGuild = (roleCount: number) => {
  const roles = buildGuildRoles({ roleCount });
  return { guild: buildGuild({ id: GUILD_ID, roles }), roles };
};

const makeChannel = (sendable: boolean) => buildSendableChannel({ sendable });

const scheduledJobs = new Map<string, Job>();

/**
 * `hasRepos: false` drops the repos bag for this guild: the plugin
 * reads it through the registry the bridge hands it, so that is what
 * the stub empties.
 */
const makeBot = (repos: ReturnType<typeof makeRepos>, hasRepos = true): BaseBot => {
  const lookup = (guildId: string): unknown =>
    hasRepos && guildId === GUILD_ID ? repos : undefined;
  return buildFakeBot({
    client: { guilds: { cache: new Map() }, channels: { fetch: vi.fn() } },
    getRepos: lookup,
    guildRegistry: {
      getRepos: lookup,
      getChannel: () => undefined,
      getRole: () => undefined,
      listGuildIds: () => [],
    },
    jobMap: scheduledJobs,
  }).bot;
};

const makeInteraction = (
  guild: Guild | null,
  channel: Channel,
  opts: { name?: string; days?: number },
): ChatInputCommandInteraction =>
  ({
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    deleteReply: vi.fn().mockResolvedValue(undefined),
    guild,
    channel,
    user: { id: 'user-1' },
    options: {
      get: (name: string) => {
        if (name === 'name') return opts.name === undefined ? undefined : { value: opts.name };
        if (name === 'days') return opts.days === undefined ? undefined : { value: opts.days };
        return undefined;
      },
    },
  }) as unknown as ChatInputCommandInteraction;

afterEach(() => {
  for (const job of scheduledJobs.values()) job.cancel();
  scheduledJobs.clear();
  vi.clearAllMocks();
});

describe('handleTempRoleCreate', () => {
  it('creates the role, posts the claim message, and removes the ephemeral ack', async () => {
    const repos = makeRepos();
    const { guild, roles } = makeGuild(10);
    const { channel, send } = makeChannel(true);
    const interaction = makeInteraction(guild, channel, { name: 'Notify', days: 7 });

    await handleTempRoleCreate(interaction, makeBot(repos));

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(roles.create).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(repos.tempRole.create).toHaveBeenCalledTimes(1);
    expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it('defaults to a 30-day lifetime when days is omitted', async () => {
    const repos = makeRepos();
    const { guild } = makeGuild(10);
    const { channel } = makeChannel(true);
    const interaction = makeInteraction(guild, channel, { name: 'Notify' });

    await handleTempRoleCreate(interaction, makeBot(repos));

    expect(repos.tempRole.create).toHaveBeenCalledTimes(1);
    expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
  });

  it('rejects a blank name without creating a role', async () => {
    const repos = makeRepos();
    const { guild, roles } = makeGuild(10);
    const { channel } = makeChannel(true);
    const interaction = makeInteraction(guild, channel, { name: '   ', days: 7 });

    await handleTempRoleCreate(interaction, makeBot(repos));

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'replies:temp_role.missing_name',
    });
    expect(roles.create).not.toHaveBeenCalled();
  });

  it('rejects a duration above the hard cap without creating a role', async () => {
    const repos = makeRepos();
    const { guild, roles } = makeGuild(10);
    const { channel } = makeChannel(true);
    const interaction = makeInteraction(guild, channel, { name: 'Notify', days: 31 });

    await handleTempRoleCreate(interaction, makeBot(repos));

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'replies:temp_role.invalid_duration',
    });
    expect(roles.create).not.toHaveBeenCalled();
  });

  it('reports the role limit and creates nothing when the guild is full', async () => {
    const repos = makeRepos();
    const { guild, roles } = makeGuild(250);
    const { channel } = makeChannel(true);
    const interaction = makeInteraction(guild, channel, { name: 'Notify', days: 7 });

    await handleTempRoleCreate(interaction, makeBot(repos));

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'replies:temp_role.at_role_limit',
    });
    expect(roles.create).not.toHaveBeenCalled();
    expect(interaction.deleteReply).not.toHaveBeenCalled();
  });

  it('reports guild_not_found when invoked outside a guild', async () => {
    const repos = makeRepos();
    const { channel } = makeChannel(true);
    const interaction = makeInteraction(null, channel, { name: 'Notify', days: 7 });

    await handleTempRoleCreate(interaction, makeBot(repos));

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'errors:command.guild_not_found',
    });
  });

  it('reports the database-not-found copy when the guild has no repos', async () => {
    const repos = makeRepos();
    const { guild, roles } = makeGuild(10);
    const { channel } = makeChannel(true);
    const interaction = makeInteraction(guild, channel, { name: 'Notify', days: 7 });
    await handleTempRoleCreate(interaction, makeBot(repos, /* hasRepos */ false));

    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'errors:db.not_found' });
    expect(roles.create).not.toHaveBeenCalled();
  });

  it('rejects when the invoking channel is not sendable', async () => {
    const repos = makeRepos();
    const { guild, roles } = makeGuild(10);
    const { channel } = makeChannel(false);
    const interaction = makeInteraction(guild, channel, { name: 'Notify', days: 7 });

    await handleTempRoleCreate(interaction, makeBot(repos));

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'errors:command.channel_not_found',
    });
    expect(roles.create).not.toHaveBeenCalled();
  });
});
