import type { ModalBuilder } from 'discord.js';
import { describe, expect, it } from 'vitest';

import GiveawayCreate from '../../../../src/handlers/commands/giveaway_create/action';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';
import { echoTranslator } from '../../../fixtures/runtime';

const { bot } = buildFakeBot({
  translator: { ...echoTranslator(), t: (key: string) => key.split('.').pop() ?? key },
});

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
    const sink = newInteractionSink();
    const interaction = buildChatInputInteraction({ options: { destination }, sink });

    await new GiveawayCreate().execute(interaction, bot);

    expect(sink.modals).toHaveLength(1);
    expect((sink.modals[0] as ModalBuilder).toJSON().custom_id).toBe(customId);
  });
});
