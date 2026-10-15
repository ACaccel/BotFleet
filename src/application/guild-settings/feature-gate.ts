import type { Interaction } from 'discord.js';
import { ENTERTAINMENT_COMMANDS, type GuildFeature } from '../../core/guild-settings';

const commandFeatures: Readonly<Record<string, GuildFeature>> = {
  ...Object.fromEntries(
    ENTERTAINMENT_COMMANDS.map((command) => [command, 'entertainment' as const]),
  ),
  ban_user: 'moderation_vote',
  talk: 'talk',
  roll_call: 'roll_call',
  traffic: 'reports',
  level_detail: 'reports',
  activity_create: 'activities',
  giveaway_create: 'giveaways',
  temp_role: 'temp_roles',
  role_message: 'role_panels',
  thread_ban: 'thread_management',
  thread_claim: 'thread_management',
};

/** Creation gates preserve participation, closure, unblock and expiry paths. */
export const featureForInteraction = (
  interaction: Interaction,
  commandId?: string,
): GuildFeature | undefined => {
  if (interaction.isChatInputCommand() || interaction.isAutocomplete()) {
    const command = commandId ?? interaction.commandName;
    const action = interaction.options.getSubcommand(false);
    const group = interaction.options.getSubcommandGroup(false);
    if (command === 'activity') {
      if (action === 'create') return 'activities';
      if (action === 'rollcall') return 'roll_call';
      return undefined;
    }
    if (command === 'giveaway') return action === 'create' ? 'giveaways' : undefined;
    if (command === 'role') {
      if (group === 'temp') return action === 'create' ? 'temp_roles' : undefined;
      return action === 'panel' ? 'role_panels' : undefined;
    }
    if (command === 'thread') {
      if (action === 'ban' || action === 'claim' || (group === 'manager' && action === 'add'))
        return 'thread_management';
      return undefined;
    }
    return commandFeatures[command];
  }
  if (interaction.isContextMenuCommand()) return commandId ? commandFeatures[commandId] : undefined;
  if (interaction.isModalSubmit()) {
    return commandFeatures[interaction.customId.split('|')[0] ?? ''];
  }
  if (interaction.isButton()) {
    const [handler, action] = interaction.customId.split('|');
    if (handler === 'level_page') return 'reports';
    if (handler === 'activity' && action === 'rollcall') return 'roll_call';
    if (handler === 'thread_claim') return 'thread_management';
  }
  return undefined;
};
