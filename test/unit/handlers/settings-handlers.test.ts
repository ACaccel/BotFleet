import {
  ComponentType,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { BaseBot } from '../../../src/bot';
import {
  handleSettingsInteraction,
  openSettingsPanel,
  type SettingsSelectInteraction,
} from '../../../src/application/guild-settings/interaction';
import Command from '../../../src/handlers/commands/settings';
import Button from '../../../src/handlers/buttons/settings';
import Select from '../../../src/handlers/select-menus/settings';
import Modal from '../../../src/handlers/modals/settings';
vi.mock('../../../src/application/guild-settings/interaction', () => ({
  openSettingsPanel: vi.fn(),
  handleSettingsInteraction: vi.fn(),
}));
const bot = {} as BaseBot;
describe('settings handler entry points', () => {
  it('routes the slash command to the guild settings controller', async () => {
    const interaction = {} as ChatInputCommandInteraction;
    await new Command().execute(interaction, bot);
    expect(openSettingsPanel).toHaveBeenCalledWith(interaction, bot);
  });
  it('routes buttons to the owner-bound controller', async () => {
    const interaction = {} as ButtonInteraction;
    await new Button().execute(interaction, bot);
    expect(handleSettingsInteraction).toHaveBeenCalledWith(interaction, bot);
  });
  it('supports string, role and channel native selectors', async () => {
    const handler = new Select();
    expect(handler.componentTypes).toEqual([
      ComponentType.StringSelect,
      ComponentType.RoleSelect,
      ComponentType.ChannelSelect,
    ]);
    const interaction = {} as SettingsSelectInteraction;
    await handler.execute(interaction, bot);
    expect(handleSettingsInteraction).toHaveBeenCalledWith(interaction, bot);
  });
  it('routes modal submissions to the nonce-bound controller', async () => {
    const interaction = {} as ModalSubmitInteraction;
    await new Modal().execute(interaction, bot);
    expect(handleSettingsInteraction).toHaveBeenCalledWith(interaction, bot);
  });
});
