/**
 * Tests for the `temp_role` command-class wrapper.
 *
 * The thin handler delegates to the plugin's `handleTempRoleCreate` and
 * owns the error boundary: an unexpected failure (e.g. a re-thrown
 * `DatabaseError` from the create rollback path) must be routed through
 * `replyForError` with the `replies:temp_role.failed` fallback copy.
 */
import type { Job } from 'node-schedule';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { err, ok } from '../../../src/core/result';
import { databaseErrorFrom } from '../../../src/persistence/error-translator';
import temp_role from '../../../src/handlers/commands/temp_role/action';
import { buildFakeBot } from '../../fixtures/discord/bot-fake';
import { buildGuild, buildGuildRoles } from '../../fixtures/discord/guild-builder';
import { buildSendableChannel } from '../../fixtures/discord/channel-builder';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../fixtures/discord/interaction-builder';

const GUILD_ID = 'guild-1';

const makeRepos = (createResult: unknown) => ({
  tempRole: {
    create: vi.fn().mockResolvedValue(createResult),
    findByRoleId: vi.fn().mockResolvedValue(ok(undefined)),
    deleteByRoleId: vi.fn().mockResolvedValue(ok(true)),
    listAll: vi.fn().mockResolvedValue(ok([])),
  },
});

const makeGuild = () => {
  const roles = buildGuildRoles({ roleCount: 10 });
  return { guild: buildGuild({ id: GUILD_ID, roles }), roles };
};

const makeChannel = () => buildSendableChannel().channel;

const scheduledJobs = new Map<string, Job>();

const makeBot = (repos: ReturnType<typeof makeRepos>) => {
  const lookup = (guildId: string): unknown => (guildId === GUILD_ID ? repos : undefined);
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

const makeInteraction = () => {
  const sink = newInteractionSink();
  const { guild, roles } = makeGuild();
  const interaction = buildChatInputInteraction({
    userId: 'user-1',
    guild,
    channel: makeChannel(),
    options: { name: 'Notify', days: 7 },
    sink,
  });
  // The builders record no `deleteReply`; the call itself is the only
  // observable of removing the acknowledgement.
  const deleteReply = vi.fn().mockResolvedValue(undefined);
  Object.assign(interaction, { deleteReply });
  return { interaction, sink, roles, deleteReply };
};

afterEach(() => {
  for (const job of scheduledJobs.values()) job?.cancel();
  scheduledJobs.clear();
  vi.clearAllMocks();
});

describe('temp_role command wrapper', () => {
  it('delegates to the plugin handler on the happy path', async () => {
    const repos = makeRepos(ok({ role_id: 'role-1' }));
    const { interaction, sink, roles, deleteReply } = makeInteraction();

    await new temp_role().execute(interaction, makeBot(repos));

    expect(roles.create).toHaveBeenCalledTimes(1);
    expect(repos.tempRole.create).toHaveBeenCalledWith(
      expect.objectContaining({ role_id: 'role-1', creator_id: 'user-1' }),
    );
    expect(deleteReply).toHaveBeenCalledTimes(1);
    expect(sink.editReplies).toEqual([]);
  });

  it('routes an unexpected failure through replyForError with the failed copy', async () => {
    const { interaction, sink, roles } = makeInteraction();
    const repos = makeRepos(err(databaseErrorFrom(new Error('boom'), { operation: 'test' })));

    await new temp_role().execute(interaction, makeBot(repos));

    // The create rollback rethrows the DatabaseError; the wrapper's catch
    // surfaces the trace-id-stamped fallback copy on the deferred reply.
    expect(sink.editReplies).toEqual([{ content: 'replies:temp_role.failed' }]);
    expect(sink.replies).toEqual([]);
    // The rollback removed the role created before the write failed.
    expect(roles.delete).toHaveBeenCalledWith('role-1', expect.any(String));
  });
});
