import type { CommandConfig } from '../command';

/**
 * No Discord default member permission: access is the bot's `admin` list, which a
 * Manage Server default would hide the command from.
 */
export const archiveCommandConfig: CommandConfig = {
  name: 'archive',
  category: 'admin',
  guildOnly: true,
  subcommands: [
    { name: 'backup' },
    { name: 'status' },
    {
      name: 'schedule',
      options: {
        boolean: [{ name: 'enabled', required: false }],
        integer: [{ name: 'minutes', required: false, min: 1, max: 10_080 }],
      },
    },
  ],
};
