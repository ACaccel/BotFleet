import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import TempRoleDelete from '../../../../src/handlers/commands/temp_role_delete/action';
import { err, ok } from '../../../../src/core/result';
import { databaseErrorFrom } from '../../../../src/persistence/error-translator';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

const ROLE_ID = 'role-1';
const CREATOR_ID = 'creator-1';
const GUILD_ID = 'guild-1';

const build = ({
  userId = 'other-member',
  admin = false,
  manageRoles = false,
  permissionSnapshot = true,
}: {
  userId?: string;
  admin?: boolean;
  manageRoles?: boolean;
  /** False models an interaction Discord sent without `memberPermissions`. */
  permissionSnapshot?: boolean;
} = {}) => {
  const doc = {
    role_id: ROLE_ID,
    creator_id: CREATOR_ID,
    channel_id: 'channel-1',
    message_id: 'message-1',
    role_name: 'Notify',
  };
  const deleteRole = vi.fn().mockResolvedValue(undefined);
  const guild = { roles: { delete: deleteRole }, channels: { cache: new Map() } };
  const findByRoleId = vi.fn().mockResolvedValue(ok(doc));
  const deleteByRoleId = vi.fn().mockResolvedValue(ok(true));
  const repos = { tempRole: { findByRoleId, deleteByRoleId } };
  const getRepos = vi.fn().mockReturnValue(repos);
  const cancel = vi.fn();
  const jobMap = new Map([[`temp-role:${ROLE_ID}`, { cancel }]]);
  const { bot, logger } = buildFakeBot({
    client: {
      guilds: { cache: new Map([[GUILD_ID, guild]]) },
      channels: { fetch: vi.fn().mockResolvedValue(null) },
    },
    guildRegistry: { getRepos },
    jobMap,
    isAdmin: (id: string) => admin && id === userId,
  });
  const sink = newInteractionSink();
  const interaction = buildChatInputInteraction({
    userId,
    guildId: GUILD_ID,
    options: { role: ROLE_ID },
    ...(permissionSnapshot
      ? { memberPermissions: manageRoles ? [PermissionFlagsBits.ManageRoles] : [] }
      : {}),
    sink,
  });
  return {
    bot,
    logger,
    interaction,
    sink,
    findByRoleId,
    deleteByRoleId,
    deleteRole,
    getRepos,
    jobMap,
    cancel,
  };
};

describe('/role temp delete', () => {
  it.each([{ userId: CREATOR_ID }, { admin: true }, { manageRoles: true }])(
    'allows the creator or a role administrator: %j',
    async (authorization) => {
      const { bot, interaction, sink, findByRoleId, deleteByRoleId, deleteRole, jobMap, cancel } =
        build(authorization);

      await new TempRoleDelete().execute(interaction, bot);

      expect(sink.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
      expect(sink.editReplies).toEqual([{ content: 'replies:temp_role.cancelled' }]);
      expect(findByRoleId).toHaveBeenCalledWith(ROLE_ID);
      expect(deleteRole).toHaveBeenCalledWith(ROLE_ID, expect.any(String));
      expect(deleteByRoleId).toHaveBeenCalledWith(ROLE_ID);
      expect(cancel).toHaveBeenCalledOnce();
      expect(jobMap.size).toBe(0);
    },
  );

  it('refuses a different member without cancelling the job or deleting its row', async () => {
    const { bot, interaction, sink, deleteByRoleId, jobMap, cancel } = build();
    await new TempRoleDelete().execute(interaction, bot);
    expect(sink.editReplies).toEqual([{ content: 'replies:temp_role.cancel_forbidden' }]);
    expect(deleteByRoleId).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(jobMap.size).toBe(1);
  });

  it('still permits the creator when Discord supplies no permission snapshot', async () => {
    const { bot, interaction, sink } = build({ userId: CREATOR_ID, permissionSnapshot: false });
    await new TempRoleDelete().execute(interaction, bot);
    expect(sink.editReplies).toEqual([{ content: 'replies:temp_role.cancelled' }]);
  });

  it('does not treat a missing permission snapshot as administrative authority', async () => {
    const { bot, interaction, sink, deleteByRoleId } = build({ permissionSnapshot: false });
    await new TempRoleDelete().execute(interaction, bot);
    expect(sink.editReplies).toEqual([{ content: 'replies:temp_role.cancel_forbidden' }]);
    expect(deleteByRoleId).not.toHaveBeenCalled();
  });

  it('rejects roles absent from the temporary-role registry without deleting anything', async () => {
    const { bot, interaction, sink, findByRoleId, deleteByRoleId, cancel } = build({ admin: true });
    findByRoleId.mockResolvedValue(ok(undefined));
    await new TempRoleDelete().execute(interaction, bot);
    expect(sink.editReplies).toEqual([{ content: 'replies:temp_role.not_temp_role' }]);
    expect(deleteByRoleId).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('reports an unavailable registry without attempting a lookup', async () => {
    const { bot, interaction, sink, getRepos, findByRoleId } = build();
    getRepos.mockReturnValue(undefined);
    await new TempRoleDelete().execute(interaction, bot);
    expect(sink.editReplies).toEqual([{ content: 'errors:db.not_found' }]);
    expect(findByRoleId).not.toHaveBeenCalled();
  });

  it('logs lookup failures and returns the deferred error fallback', async () => {
    const { bot, logger, interaction, sink, findByRoleId, deleteByRoleId } = build();
    findByRoleId.mockResolvedValue(
      err(databaseErrorFrom(new Error('database unavailable'), { operation: 'temp_role.test' })),
    );
    await new TempRoleDelete().execute(interaction, bot);
    expect(sink.editReplies).toEqual([{ content: 'replies:temp_role.failed' }]);
    expect(logger.error).toHaveBeenCalled();
    expect(deleteByRoleId).not.toHaveBeenCalled();
    expect(sink.replies).toEqual([]);
  });

  it('does not report success when deleting the stored role fails', async () => {
    const { bot, logger, interaction, sink, deleteByRoleId } = build({ userId: CREATOR_ID });
    deleteByRoleId.mockResolvedValue(
      err(databaseErrorFrom(new Error('database unavailable'), { operation: 'temp_role.test' })),
    );
    await new TempRoleDelete().execute(interaction, bot);
    expect(sink.editReplies).toEqual([{ content: 'replies:temp_role.failed' }]);
    expect(logger.error).toHaveBeenCalled();
  });

  it('handles a missing required role option without performing side effects', async () => {
    const { bot, sink, getRepos, deleteByRoleId } = build({ userId: CREATOR_ID });
    const interaction = buildChatInputInteraction({ guildId: GUILD_ID, sink });
    await new TempRoleDelete().execute(interaction, bot);
    expect(sink.editReplies).toEqual([{ content: 'replies:temp_role.failed' }]);
    expect(getRepos).not.toHaveBeenCalled();
    expect(deleteByRoleId).not.toHaveBeenCalled();
  });

  it('reports a refused Discord deletion and keeps the record', async () => {
    const { bot, interaction, sink, deleteRole, deleteByRoleId } = build({ userId: CREATOR_ID });
    deleteRole.mockRejectedValue(new Error('Missing Permissions'));

    await new TempRoleDelete().execute(interaction, bot);

    expect(sink.editReplies).toEqual([{ content: 'replies:temp_role.failed' }]);
    expect(deleteByRoleId).not.toHaveBeenCalled();
  });
});
