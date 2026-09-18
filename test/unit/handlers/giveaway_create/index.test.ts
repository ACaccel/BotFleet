import type { BaseBot } from '@bot';
import type { ChatInputCommandInteraction, ModalBuilder } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import GiveawayCreate from '../../../../src/handlers/commands/giveaway_create';

const bot = {
  translator: { t: (key: string) => key.split('.').pop() ?? key },
} as unknown as BaseBot;

describe('giveaway_create destination', () => {
  it('offers an optional choice between current and configured channels', () => {
    expect(new GiveawayCreate().config.options?.string).toEqual([
      {
        name: 'destination',
        required: false,
        choices: [{ value: 'current' }, { value: 'configured' }],
      },
    ]);
  });

  it.each([
    [null, 'giveaway_create'],
    ['current', 'giveaway_create'],
    ['configured', 'giveaway_create|configured'],
  ])('preserves destination %s in the modal', async (destination, customId) => {
    const showModal = vi.fn();
    const getString = vi.fn().mockReturnValue(destination);
    const interaction = {
      options: { getString },
      showModal,
    } as unknown as ChatInputCommandInteraction;

    await new GiveawayCreate().execute(interaction, bot);

    expect(getString).toHaveBeenCalledWith('destination');
    const modal = showModal.mock.calls[0]?.[0] as ModalBuilder;
    expect(modal.toJSON().custom_id).toBe(customId);
  });
});
