import { PermissionFlagsBits } from 'discord.js';
import { vi } from 'vitest';
import type { BaseBot } from '../../../../src/bot';
import type { ArchiveControl } from '../../../../src/application/archive/control';
import { buildFakeBot, echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';
import { buildTextChannel } from '../../../fixtures/discord/channel-builder';
import { buildGuild } from '../../../fixtures/discord/guild-builder';

export const GUILD_ID = '123456789012345678';
export const DEBUG_ID = '200000000000000000';
export const ADMIN_ID = '300000000000000000';

/** A msg-archive bot whose debug channel lets the bot send embeds. */
export const archiveBot = (
  input: {
    admins?: readonly string[];
    backupServers?: readonly string[];
    worker?: boolean;
    /** The control service the injected `ArchiveControlFactory` returns. */
    control?: Partial<ArchiveControl>;
  } = {},
): {
  bot: BaseBot;
  logger: ReturnType<typeof buildFakeBot>['logger'];
  getConnection: ReturnType<typeof vi.fn>;
  createControl: ReturnType<typeof vi.fn>;
} => {
  const admins = input.admins ?? [ADMIN_ID];
  const getConnection = vi.fn().mockResolvedValue({
    connection: { db: {} },
    archiveOwner: input.worker === false ? undefined : 'msg-archive',
  });
  const createControl = vi.fn(() => input.control ?? {});
  const { bot, logger } = buildFakeBot({
    translator: echoTranslatorWithParams(),
    isAdmin: (userId: string) => admins.includes(userId),
    config: {
      backup_server: input.backupServers ?? [GUILD_ID],
      guilds: { [GUILD_ID]: { channels: { debug: DEBUG_ID } } },
    },
    connectionManager: { getConnection, isDisabled: () => undefined },
    archiveControlFactory: createControl,
  });
  return { bot, logger, getConnection, createControl };
};

/** The guild the command runs in; `ownerId` defaults to the admin. */
export const archiveGuild = (ownerId = ADMIN_ID) => {
  const debug = buildTextChannel({
    id: DEBUG_ID,
    permissionsBySubject: {
      bot: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
  });
  return Object.assign(buildGuild({ id: GUILD_ID, channels: [debug], me: { id: 'bot' } }), {
    ownerId,
  });
};
