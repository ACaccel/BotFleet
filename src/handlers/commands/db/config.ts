import type { CommandConfig } from '../command';

/** Discord lists required options first, so `guild` follows each subcommand's required ones. */
const guild = { name: 'guild', required: false, autocomplete: true } as const;
const collection = { name: 'collection', required: true, autocomplete: true } as const;

/**
 * No Discord default member permission and usable in DMs: access is the bot's
 * `admin` list, and a DM is where an admin inspects guilds the bot is not in.
 */
export const dbCommandConfig: CommandConfig = {
  name: 'db',
  category: 'admin',
  subcommands: [
    { name: 'stats', adminOnly: true, options: { string: [guild] } },
    { name: 'schema', adminOnly: true, options: { string: [collection, guild] } },
    {
      name: 'list',
      adminOnly: true,
      options: {
        string: [
          collection,
          guild,
          { name: 'field', required: false, autocomplete: true },
          { name: 'operator', required: false, autocomplete: true },
          { name: 'value', required: false, autocomplete: true, maxLength: 100 },
          { name: 'sort', required: false, autocomplete: true },
        ],
      },
    },
    {
      name: 'get',
      adminOnly: true,
      options: {
        string: [collection, { name: 'id', required: true, autocomplete: true }, guild],
      },
    },
  ],
};
