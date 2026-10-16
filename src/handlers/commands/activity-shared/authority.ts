import { PermissionFlagsBits, type RepliableInteraction } from 'discord.js';
import type { BaseBot } from '@bot';

/**
 * Whether the requester may close, cancel or roll-call an activity made
 * by `creatorId`: its creator, a member who manages events or messages,
 * or a bot admin. Activities from before creators were recorded need a
 * manager.
 */
export const canManageActivity = (
  interaction: Pick<RepliableInteraction, 'user' | 'memberPermissions'>,
  bot: Pick<BaseBot, 'isAdmin'>,
  creatorId: string | null | undefined,
): boolean =>
  (typeof creatorId === 'string' && creatorId === interaction.user.id) ||
  bot.isAdmin(interaction.user.id) ||
  interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents) === true ||
  interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) === true;
