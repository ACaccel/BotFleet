import { GatewayIntentBits, IntentsBitField } from 'discord.js';
import { describe, expect, it } from 'vitest';

import { GUILD_OBSERVER_INTENTS, MESSAGE_BOT_INTENTS } from '../../../src/bot/bootstrap';

describe('personality gateway intents', () => {
  it.each([
    ['guild observer', GUILD_OBSERVER_INTENTS],
    ['message bot', MESSAGE_BOT_INTENTS],
  ] as const)(
    '%s receives guild messages without subscribing to voice states',
    (_name, intents) => {
      const bitfield = new IntentsBitField([...intents]);

      expect(bitfield.has(GatewayIntentBits.GuildVoiceStates)).toBe(false);
      expect(
        bitfield.has([
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
        ]),
      ).toBe(true);
    },
  );
});
