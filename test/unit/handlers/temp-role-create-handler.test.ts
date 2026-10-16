/**
 * Handler-level tests for `handleTempRoleCreate`.
 *
 * The handler imports `BaseBot` type-only, so this test constructs
 * minimal fakes for the interaction, bot, guild, channel and repos —
 * no handler-registry or real Discord wiring.
 */
import type { Job } from 'node-schedule';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageFlags, type Channel, type Guild } from 'discord.js';

import { ok } from '../../../src/core/result';
import { handleTempRoleCreate } from '../../../src/handlers/commands/temp_role/create';
import { buildFakeBot, echoTranslatorWithParams } from '../../fixtures/discord/bot-fake';
import { buildGuild, buildGuildRoles } from '../../fixtures/discord/guild-builder';
import { buildSendableChannel } from '../../fixtures/discord/channel-builder';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../fixtures/discord/interaction-builder';

const GUILD_ID = 'guild-1';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
const makeBot = (repos: ReturnType<typeof makeRepos>, hasRepos = true) => {
  const lookup = (guildId: string): unknown =>
    hasRepos && guildId === GUILD_ID ? repos : undefined;
  return buildFakeBot({
    client: { guilds: { cache: new Map() }, channels: { fetch: vi.fn() } },
    translator: echoTranslatorWithParams(),
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
) => {
  const sink = newInteractionSink();
  const options: Record<string, string | number> = {};
  if (opts.name !== undefined) options.name = opts.name;
  if (opts.days !== undefined) options.days = opts.days;
  const interaction = buildChatInputInteraction({
    userId: 'user-1',
    ...(guild === null ? { guildId: null } : { guild }),
    channel,
    options,
    sink,
  });
  return { interaction, sink };
};

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
    const { interaction, sink } = makeInteraction(guild, channel, {
      name: 'Notify',
      days: 7,
    });
    const before = Date.now();

    await handleTempRoleCreate(interaction, makeBot(repos));

    expect(sink.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    // The role is powerless and mentionable, carrying the impersonation-proof prefix.
    expect(roles.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: '🔔 Notify', mentionable: true, permissions: [] }),
    );
    // The claim message carries a toggle button bound to the new role.
    expect(send).toHaveBeenCalledTimes(1);
    const claim = send.mock.calls[0]?.[0] as {
      content: string;
      components: { toJSON: () => { components: { custom_id: string }[] } }[];
    };
    expect(claim.content).toContain('replies:temp_role.created');
    expect(claim.content).toContain('<@&role-1>');
    expect(claim.components[0]?.toJSON().components[0]?.custom_id).toBe('toggle_role|role-1');
    // The row lets a reboot rebuild the expiry, and a job is armed now.
    const stored = repos.tempRole.create.mock.calls[0]?.[0] as {
      expires_at: number;
      role_name: string;
    };
    expect(repos.tempRole.create).toHaveBeenCalledWith(
      expect.objectContaining({
        role_id: 'role-1',
        channel_id: 'chan-1',
        message_id: 'msg-1',
        creator_id: 'user-1',
        role_name: '🔔 Notify',
      }),
    );
    expect(stored.expires_at).toBeGreaterThanOrEqual(before + 7 * MS_PER_DAY);
    expect(stored.expires_at).toBeLessThanOrEqual(Date.now() + 7 * MS_PER_DAY);
    expect(scheduledJobs.has('temp-role:role-1')).toBe(true);
    // The public claim message is the only visible output.
    expect(sink.deletes).toEqual(['@original']);
    expect(sink.editReplies).toEqual([]);
  });

  it('defaults to a 30-day lifetime when days is omitted', async () => {
    const repos = makeRepos();
    const { guild } = makeGuild(10);
    const { channel } = makeChannel(true);
    const { interaction, sink } = makeInteraction(guild, channel, { name: 'Notify' });
    const before = Date.now();

    await handleTempRoleCreate(interaction, makeBot(repos));

    const stored = repos.tempRole.create.mock.calls[0]?.[0] as { expires_at: number };
    expect(stored.expires_at).toBeGreaterThanOrEqual(before + 30 * MS_PER_DAY);
    expect(stored.expires_at).toBeLessThanOrEqual(Date.now() + 30 * MS_PER_DAY);
    expect(sink.deletes).toEqual(['@original']);
  });

  it('rejects a blank name without creating a role', async () => {
    const repos = makeRepos();
    const { guild, roles } = makeGuild(10);
    const { channel, send } = makeChannel(true);
    const { interaction, sink } = makeInteraction(guild, channel, { name: '   ', days: 7 });

    await handleTempRoleCreate(interaction, makeBot(repos));

    expect(sink.editReplies).toEqual([{ content: 'replies:temp_role.missing_name' }]);
    expect(roles.create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(repos.tempRole.create).not.toHaveBeenCalled();
  });

  it('rejects a duration above the hard cap without creating a role', async () => {
    const repos = makeRepos();
    const { guild, roles } = makeGuild(10);
    const { channel } = makeChannel(true);
    const { interaction, sink } = makeInteraction(guild, channel, { name: 'Notify', days: 31 });

    await handleTempRoleCreate(interaction, makeBot(repos));

    expect(sink.editReplies).toEqual([
      { content: 'replies:temp_role.invalid_duration:{"max":30}' },
    ]);
    expect(roles.create).not.toHaveBeenCalled();
  });

  it('reports the role limit and creates nothing when the guild is full', async () => {
    const repos = makeRepos();
    const { guild, roles } = makeGuild(250);
    const { channel } = makeChannel(true);
    const { interaction, sink } = makeInteraction(guild, channel, {
      name: 'Notify',
      days: 7,
    });

    await handleTempRoleCreate(interaction, makeBot(repos));

    expect(sink.editReplies).toEqual([{ content: 'replies:temp_role.at_role_limit:{"max":250}' }]);
    expect(roles.create).not.toHaveBeenCalled();
    expect(sink.deletes).toEqual([]);
  });

  it('reports guild_not_found when invoked outside a guild', async () => {
    const repos = makeRepos();
    const { channel } = makeChannel(true);
    const { interaction, sink } = makeInteraction(null, channel, { name: 'Notify', days: 7 });

    await handleTempRoleCreate(interaction, makeBot(repos));

    expect(sink.editReplies).toEqual([{ content: 'errors:command.guild_not_found' }]);
  });

  it('reports the database-not-found copy when the guild has no repos', async () => {
    const repos = makeRepos();
    const { guild, roles } = makeGuild(10);
    const { channel } = makeChannel(true);
    const { interaction, sink } = makeInteraction(guild, channel, { name: 'Notify', days: 7 });
    await handleTempRoleCreate(interaction, makeBot(repos, /* hasRepos */ false));

    expect(sink.editReplies).toEqual([{ content: 'errors:db.not_found' }]);
    expect(roles.create).not.toHaveBeenCalled();
  });

  it('rejects when the invoking channel is not sendable', async () => {
    const repos = makeRepos();
    const { guild, roles } = makeGuild(10);
    const { channel } = makeChannel(false);
    const { interaction, sink } = makeInteraction(guild, channel, { name: 'Notify', days: 7 });

    await handleTempRoleCreate(interaction, makeBot(repos));

    expect(sink.editReplies).toEqual([{ content: 'errors:command.channel_not_found' }]);
    expect(roles.create).not.toHaveBeenCalled();
  });
});
