import { PermissionFlagsBits } from 'discord.js';
import type { CommandConfig } from '../command';
const pageOption = { name: 'page', required: false, min: 1, max: 100_000 };
export const confirmedActions = ['apply', 'resume', 'rollback', 'accept'] as const;
export const archiveCommandConfig: CommandConfig = {
  name: 'archive',
  category: 'admin',
  guildOnly: true,
  defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
  subcommandGroups: [
    {
      name: 'schedule',
      subcommands: [
        { name: 'status', options: { number: [pageOption] } },
        {
          name: 'enable',
          options: { number: [{ name: 'minutes', required: false, min: 1, max: 10_080 }] },
        },
        { name: 'disable' },
        {
          name: 'interval',
          options: { number: [{ name: 'minutes', required: true, min: 1, max: 10_080 }] },
        },
      ],
    },
  ],
  subcommands: [{ name: 'backup' }, { name: 'jobs' }, { name: 'plans' }],
};
