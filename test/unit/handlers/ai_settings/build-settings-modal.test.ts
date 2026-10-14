import { ModalBuilder } from 'discord.js';
import { describe, expect, it } from 'vitest';

import { buildSettingsModal } from '../../../../src/handlers/commands/ai_settings/build-settings-modal';
import type { UserApiDoc } from '../../../../src/handlers/commands/ai_settings/provider-choices';
import { echoTranslator } from '../../../fixtures/runtime';

const doc: UserApiDoc = {
  provider: 'openai',
  model: 'gpt-4',
  temperature: 0.5,
  system_prompt: 'be helpful',
  web_search: true,
};

// Stub translator echoing the key's last segment: short and non-empty
// so each underlying builder passes its min/max length validators, and
// traceable back to the key that produced it.
const stubTranslator = {
  ...echoTranslator(),
  t: (key: string): string => key.split('.').pop() ?? key,
};

/** Every label rendered on the modal, in declaration order. */
const labelsOf = (modal: ModalBuilder): string[] =>
  modal.toJSON().components.map((component) => ('label' in component ? component.label : ''));

describe('buildSettingsModal', () => {
  it('returns a ModalBuilder instance', () => {
    const modal = buildSettingsModal('openai', doc, ['gpt-4', 'gpt-4o'], stubTranslator);
    expect(modal).toBeInstanceOf(ModalBuilder);
  });

  it('encodes the provider into the modal custom id', () => {
    const modal = buildSettingsModal('openai', doc, ['gpt-4', 'gpt-4o'], stubTranslator);
    expect(modal.toJSON().custom_id).toBe('ai_settings|openai');
  });

  it('keeps four label components on the modal', () => {
    const modal = buildSettingsModal('anthropic', doc, ['gpt-4', 'gpt-4o'], stubTranslator);
    const components = modal.toJSON().components;
    expect(components).toHaveLength(4);
  });

  it('resolves every label through the translator', () => {
    // The four labels and the temperature placeholder were hardcoded
    // English, which the CJK scanner cannot see because they are Latin.
    const modal = buildSettingsModal('openai', doc, ['gpt-4'], stubTranslator);
    expect(labelsOf(modal)).toEqual([
      'label_model',
      'label_temperature',
      'label_web_search',
      'label_system_prompt',
    ]);
  });
});
