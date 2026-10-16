import { PermissionFlagsBits, type RepliableInteraction } from 'discord.js';
import type { BaseBot } from '@bot';

/**
 * Whether the requester may delete an auto-reply added by `createdBy`:
 * its author, a member who manages messages, or a bot admin. Pairs added
 * before authors were recorded need a manager.
 */
export const canDeleteReply = (
  interaction: Pick<RepliableInteraction, 'user' | 'memberPermissions'>,
  bot: Pick<BaseBot, 'isAdmin'>,
  createdBy: string | null | undefined,
): boolean =>
  (createdBy !== undefined && createdBy !== null && createdBy === interaction.user.id) ||
  bot.isAdmin(interaction.user.id) ||
  interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) === true;
