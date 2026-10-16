import { ComponentType } from 'discord.js';
import type { BaseBot } from '@bot';
import { SSMHandler } from '../ssm-handler';
import {
  handleSettingsInteraction,
  type SettingsSelectInteraction,
} from '../../../application/guild-settings/interaction';

export default class settings extends SSMHandler<SettingsSelectInteraction> {
  public override readonly componentTypes = [
    ComponentType.StringSelect,
    ComponentType.RoleSelect,
    ComponentType.ChannelSelect,
  ];
  public override async execute(
    interaction: SettingsSelectInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await handleSettingsInteraction(interaction, bot);
  }
}
