import { describe, expect, it } from 'vitest';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { ArchiveAccessError, ConfigurationError } from '../../../../src/core/errors';
import type { ChatInputCommandInteraction } from 'discord.js';
import { requireArchiveAccess } from '../../../../src/handlers/commands/archive-shared/access';
import type {
  ArchiveControl,
  ArchiveControlTarget,
} from '../../../../src/application/archive/control';
import { buildChatInputInteraction } from '../../../fixtures/discord/interaction-builder';
import { ADMIN_ID, DEBUG_ID, GUILD_ID, archiveBot, archiveGuild } from './fixtures';

const interaction = (
  userId: string,
  options: { channelId?: string; ownerId?: string } = {},
): ChatInputCommandInteraction =>
  buildChatInputInteraction({
    commandName: 'archive',
    userId,
    guild: archiveGuild(options.ownerId),
    channel: { id: options.channelId ?? DEBUG_ID },
  });
const denied = (messageKey: string) =>
  expect.objectContaining({ name: 'ArchiveAccessError', messageKey });

describe('archive access', () => {
  it('admits a listed admin in the debug channel of a backup server on msg-archive', async () => {
    const { bot } = archiveBot();
    const access = await requireArchiveAccess(interaction(ADMIN_ID), bot);
    expect(access).toMatchObject({ guildId: GUILD_ID, guildName: 'TestGuild' });
  });

  it('builds the guild control through the injected factory', async () => {
    const control = { deadLetterCount: async () => 0 } satisfies Partial<ArchiveControl>;
    const { bot, createControl, getConnection } = archiveBot({ control });
    Object.assign(bot.config, { backup_interval_minutes: 30 });
    const access = await requireArchiveAccess(interaction(ADMIN_ID), bot);
    expect(access.control).toBe(control);
    expect(createControl).toHaveBeenCalledWith({
      guild: await getConnection.mock.results[0]?.value,
      defaultIntervalMs: 1_800_000,
    } satisfies ArchiveControlTarget);
  });

  it('needs the control factory only where archive ownership lives', async () => {
    const other = archiveBot({ worker: false }).bot;
    Object.assign(other, { archiveControlFactory: undefined });
    await expect(requireArchiveAccess(interaction(ADMIN_ID), other)).rejects.toEqual(
      denied('replies:archive.worker_only'),
    );
    const unwired = archiveBot().bot;
    Object.assign(unwired, { archiveControlFactory: undefined });
    await expect(requireArchiveAccess(interaction(ADMIN_ID), unwired)).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });

  it('rejects users outside the admin list, including the server owner', async () => {
    const { bot, getConnection } = archiveBot();
    const owner = '400000000000000000';
    await expect(requireArchiveAccess(interaction(owner, { ownerId: owner }), bot)).rejects.toEqual(
      denied('replies:archive.permission_denied'),
    );
    expect(getConnection).not.toHaveBeenCalled();
  });

  it('rejects admins outside the debug channel', async () => {
    const { bot } = archiveBot();
    await expect(
      requireArchiveAccess(interaction(ADMIN_ID, { channelId: '999' }), bot),
    ).rejects.toEqual(denied('replies:archive.debug_only'));
  });

  it('rejects servers outside backup_server and bots other than msg-archive', async () => {
    await expect(
      requireArchiveAccess(interaction(ADMIN_ID), archiveBot({ backupServers: ['1'] }).bot),
    ).rejects.toEqual(denied('replies:archive.guild_not_configured'));
    await expect(
      requireArchiveAccess(interaction(ADMIN_ID), archiveBot({ worker: false }).bot),
    ).rejects.toEqual(denied('replies:archive.worker_only'));
  });

  it('rejects direct messages', async () => {
    const { bot } = archiveBot();
    const direct = buildChatInputInteraction({ commandName: 'archive', guildId: null });
    await expect(requireArchiveAccess(direct, bot)).rejects.toBeInstanceOf(ArchiveAccessError);
  });

  it('rejects a Manage Server holder outside the admin list', async () => {
    const { bot } = archiveBot();
    const manager = interaction('400000000000000000');
    Object.assign(manager, {
      memberPermissions: new PermissionsBitField([PermissionFlagsBits.ManageGuild]),
    });
    await expect(requireArchiveAccess(manager, bot)).rejects.toEqual(
      denied('replies:archive.permission_denied'),
    );
  });

  it('names the startup error of a guild whose database is disabled', async () => {
    const { bot, getConnection } = archiveBot();
    Object.assign(bot.connectionManager!, { isDisabled: () => ({ traceId: 'abc123' }) });
    await expect(requireArchiveAccess(interaction(ADMIN_ID), bot)).rejects.toMatchObject({
      messageKey: 'errors:db.guild_disabled',
      messageParams: { traceId: 'abc123' },
    });
    expect(getConnection).not.toHaveBeenCalled();
  });

  it('rejects a debug channel where the bot cannot embed', async () => {
    const { bot } = archiveBot();
    const guild = archiveGuild();
    const debug = guild.channels.cache.get(DEBUG_ID)!;
    Object.assign(debug, {
      permissionsFor: () => ({ has: (flag: bigint) => flag !== PermissionFlagsBits.EmbedLinks }),
    });
    const target = buildChatInputInteraction({
      commandName: 'archive',
      userId: ADMIN_ID,
      guild,
      channel: { id: DEBUG_ID },
    });
    await expect(requireArchiveAccess(target, bot)).rejects.toEqual(
      denied('replies:archive.debug_permissions'),
    );
  });

  it('reports malformed archive configuration as a configuration fault', async () => {
    const { bot } = archiveBot();
    Object.assign(bot, { config: { ...bot.config, backup_server: 'not-a-list' } });
    await expect(requireArchiveAccess(interaction(ADMIN_ID), bot)).rejects.toBeInstanceOf(
      ConfigurationError,
    );
    const noManager = archiveBot().bot;
    Object.assign(noManager, { connectionManager: undefined });
    await expect(requireArchiveAccess(interaction(ADMIN_ID), noManager)).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });
});
