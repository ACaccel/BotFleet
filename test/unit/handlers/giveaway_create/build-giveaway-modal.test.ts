import type { BaseBot } from '@bot';
import { ModalBuilder } from 'discord.js';
import { describe, expect, it } from 'vitest';

import { buildGiveawayModal } from '../../../../src/handlers/commands/giveaway_create/build-giveaway-modal';

// Stub translator that echoes the last key segment, so assertions stay
// independent of catalog wording.
const stubTranslator = {
  t: (key: string): string => key.split('.').pop() ?? key,
} as unknown as BaseBot['translator'];

describe('buildGiveawayModal', () => {
  it('returns a ModalBuilder instance', () => {
    expect(buildGiveawayModal(stubTranslator)).toBeInstanceOf(ModalBuilder);
  });

  it('uses giveaway_create as the modal custom id', () => {
    const modal = buildGiveawayModal(stubTranslator);
    const data = (modal as unknown as { data: { custom_id?: string } }).data;
    expect(data.custom_id).toBe('giveaway_create');
  });

  it('carries the configured destination in the modal custom id', () => {
    expect(buildGiveawayModal(stubTranslator, true).toJSON().custom_id).toBe(
      'giveaway_create|configured',
    );
  });

  it('keeps four label components on the modal', () => {
    const modal = buildGiveawayModal(stubTranslator);
    // discord.js v14 builders may attach components on the builder root
    // or inside `data`; accept either shape so the assertion tracks the
    // actual fluent-builder count.
    const fromRoot = (modal as unknown as { components?: unknown[] }).components;
    const fromData = (modal as unknown as { data?: { components?: unknown[] } }).data?.components;
    const components = fromData ?? fromRoot;
    expect(components).toBeDefined();
    expect(components).toHaveLength(4);
  });
});
