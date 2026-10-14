import { ModalBuilder } from 'discord.js';
import { describe, expect, it } from 'vitest';

import { buildGiveawayModal } from '../../../../src/handlers/commands/giveaway_create/build-giveaway-modal';
import { echoTranslator } from '../../../fixtures/runtime';

// Stub translator that echoes the last key segment, so assertions stay
// independent of catalog wording.
const stubTranslator = {
  ...echoTranslator(),
  t: (key: string): string => key.split('.').pop() ?? key,
};

describe('buildGiveawayModal', () => {
  it('returns a ModalBuilder instance', () => {
    expect(buildGiveawayModal(stubTranslator)).toBeInstanceOf(ModalBuilder);
  });

  it('uses giveaway_create as the modal custom id', () => {
    const modal = buildGiveawayModal(stubTranslator);
    expect(modal.toJSON().custom_id).toBe('giveaway_create');
  });

  it('carries the configured destination in the modal custom id', () => {
    expect(buildGiveawayModal(stubTranslator, true).toJSON().custom_id).toBe(
      'giveaway_create|configured',
    );
  });

  it('keeps four label components on the modal', () => {
    const modal = buildGiveawayModal(stubTranslator);
    const components = modal.toJSON().components;
    expect(components).toHaveLength(4);
  });
});
