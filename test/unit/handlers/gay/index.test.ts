/** `/gay` always answers, never pings, and reads pairs when given a second member. */
import { describe, expect, it, vi } from 'vitest';

import Gay from '../../../../src/handlers/commands/gay';
import { createPermissionRankPolicy } from '../../../../src/core/plugin';
import { ok, err } from '../../../../src/core/result';
import { databaseErrorFrom } from '../../../../src/persistence/error-translator';
import type { GayStatsRepo } from '../../../../src/persistence/repositories/gay-stats.types';
import type { GayReadingRepo } from '../../../../src/persistence/repositories/gay-reading.repo';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import { buildTextChannel } from '../../../fixtures/discord/channel-builder';
import { buildGuild, buildGuildRoles } from '../../../fixtures/discord/guild-builder';
import { buildGuildMember } from '../../../fixtures/discord/member-builder';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

const user = (id: string) => ({ id, displayName: `name-${id}` });

const run = async (second?: string) => {
  const sink = newInteractionSink();
  const interaction = buildChatInputInteraction({
    users: {
      user: user('u1'),
      ...(second === undefined ? {} : { user2: user(second) }),
    },
    sink,
  });
  // Neither member is cached: the reply must still go out. The builder
  // has no member resolver.
  Object.assign(interaction.options, { getMember: () => null });
  const { bot } = buildFakeBot({ timeZone: 'UTC' });
  await new Gay().execute(interaction, bot);
  return sink.replies[0];
};

const archiveFixture = () => {
  const invoker = buildGuildMember({ id: 'invoker' });
  const command = buildTextChannel({ id: 'public' });
  const restricted = buildTextChannel({
    id: 'restricted',
    viewableByAll: false,
    viewableBy: new Set(['invoker']),
  });
  const guild = buildGuild({
    id: 'g1',
    members: [invoker],
    channels: [command, restricted],
    roles: buildGuildRoles({ roles: [{ id: 'everyone', name: '@everyone' }] }),
  });
  const sink = newInteractionSink();
  const interaction = buildChatInputInteraction({
    guild,
    userId: 'invoker',
    channel: command,
    users: { user: user('u1'), user2: user('u2') },
    sink,
  });
  Object.assign(interaction.options, { getMember: () => null });
  const gayStats = {
    listChannels: vi.fn<GayStatsRepo['listChannels']>(async () => ok([])),
    summarize: vi.fn<GayStatsRepo['summarize']>(async () => ok(undefined)),
  };
  const gayReading = {
    find: vi.fn<GayReadingRepo['find']>(async () => ok(undefined)),
    remember: vi.fn<GayReadingRepo['remember']>(async (_key, reading) => ok(reading)),
  };
  const { bot } = buildFakeBot({
    timeZone: 'UTC',
    permissionRankPolicy: createPermissionRankPolicy({}),
    getRepos: () => ({ gayStats, gayReading }),
  });
  return { bot, interaction, guild, sink, gayStats, gayReading };
};

describe('/gay', () => {
  it('answers a single reading for an uncached member without pinging', async () => {
    const sent = await run();

    expect(sent?.content).toMatch(/^replies:gay\.single\n> replies:gay\.single_/);
    expect(sent?.allowedMentions).toEqual({ parse: [] });
  });

  it('reads the pair when a second member is given', async () => {
    const sent = await run('u2');

    expect(sent?.content).toMatch(/^replies:gay\.pair\n> replies:gay\.pair_/);
  });

  it('defers before archive queries and counts only channels its public audience can view', async () => {
    const f = archiveFixture();
    f.gayStats.listChannels.mockImplementation(async () => {
      expect(f.sink.defers).toHaveLength(1);
      return ok([]);
    });
    await new Gay().execute(f.interaction, f.bot);
    expect(f.gayStats.summarize).toHaveBeenCalledWith(
      expect.objectContaining({
        userIds: ['u1', 'u2'],
        channelIds: ['public'],
      }),
    );
    expect(f.sink.editReplies[0]?.content).toMatch(/^replies:gay\.pair/);
    expect(f.sink.editReplies[0]?.allowedMentions).toEqual({ parse: [] });
    expect(f.sink.replies).toHaveLength(0);
  });

  it('checks permissions even when a stored reading exists', async () => {
    const f = archiveFixture();
    f.gayReading.find.mockResolvedValue(
      ok({ percent: 100, commentKey: 'replies:gay.pair_high_1' }),
    );
    await new Gay().execute(f.interaction, f.bot);
    expect(f.gayStats.listChannels).toHaveBeenCalledOnce();
    expect(f.gayReading.find).toHaveBeenCalledOnce();
    expect(f.gayStats.summarize).not.toHaveBeenCalled();
  });

  it('falls back when metadata times out, without exposing an error or reading snapshots', async () => {
    const f = archiveFixture();
    f.gayStats.listChannels.mockResolvedValue(
      err(databaseErrorFrom({ code: 50 }, { operation: 'test' })),
    );
    await new Gay().execute(f.interaction, f.bot);
    expect(f.sink.editReplies[0]?.content).toMatch(/^replies:gay\.pair/);
    expect(f.gayReading.find).not.toHaveBeenCalled();
    expect(f.gayStats.summarize).not.toHaveBeenCalled();
  });

  it('skips the archive when the invoking member is unavailable', async () => {
    const f = archiveFixture();
    f.guild.members.cache.clear();
    await new Gay().execute(f.interaction, f.bot);
    expect(f.gayStats.listChannels).not.toHaveBeenCalled();
    expect(f.sink.defers).toHaveLength(0);
    expect(f.sink.replies[0]?.content).toMatch(/^replies:gay\.pair/);
  });
});
