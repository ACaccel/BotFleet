import type { Interaction } from 'discord.js';

/** Review DMs carry their source guild in an authenticated claim checked by the handler. */
export const guildIdForInteraction = (interaction: Interaction): string | undefined =>
  interaction.guildId ??
  ('customId' in interaction
    ? /^thread_claim\|(?:approve|reject)\|(\d{17,20})\|/.exec(interaction.customId)?.[1]
    : undefined);

/** Discord event payloads expose the source guild on messages, members, channels, or guild events. */
export const guildIdForEvent = (event: string, args: readonly unknown[]): string | undefined => {
  for (const value of args) {
    if (typeof value !== 'object' || value === null) continue;
    if ('guildId' in value && typeof value.guildId === 'string') return value.guildId;
    if (
      'guild' in value &&
      value.guild &&
      typeof value.guild === 'object' &&
      'id' in value.guild &&
      typeof value.guild.id === 'string'
    )
      return value.guild.id;
    if (
      ['guildCreate', 'guildDelete', 'guildUpdate', 'guildAvailable', 'guildUnavailable'].includes(
        event,
      ) &&
      'id' in value &&
      typeof value.id === 'string'
    )
      return value.id;
  }
  return undefined;
};
