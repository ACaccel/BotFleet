import { describe, expect, it } from 'vitest';
import { featureForInteraction } from '../../../../src/application/guild-settings/feature-gate';
import {
  buildButtonInteraction,
  buildChatInputInteraction,
  buildModalSubmitInteraction,
} from '../../../fixtures/discord/interaction-builder';

describe('guild feature creation gates', () => {
  it.each([
    ['activity', 'create', undefined, 'activities'],
    ['giveaway', 'create', undefined, 'giveaways'],
    ['role', 'create', 'temp', 'temp_roles'],
    ['role', 'panel', undefined, 'role_panels'],
    ['thread', 'ban', undefined, 'thread_management'],
    ['thread', 'add', 'manager', 'thread_management'],
    ['traffic', 'overview', undefined, 'reports'],
  ] as const)(
    'gates %s %s through its feature',
    (commandName, subcommand, subcommandGroup, expected) => {
      expect(
        featureForInteraction(
          buildChatInputInteraction({ commandName, subcommand, subcommandGroup }),
        ),
      ).toBe(expected);
    },
  );
  it.each([
    ['activity', 'close', undefined],
    ['activity', 'cancel', undefined],
    ['giveaway', 'delete', undefined],
    ['role', 'delete', 'temp'],
    ['thread', 'allow', undefined],
    ['thread', 'remove', 'manager'],
    ['reply', 'add', undefined],
    ['settings', undefined, undefined],
  ] as const)(
    'preserves cleanup and configuration path %s %s',
    (commandName, subcommand, subcommandGroup) => {
      expect(
        featureForInteraction(
          buildChatInputInteraction({ commandName, subcommand, subcommandGroup }),
        ),
      ).toBeUndefined();
    },
  );
  it('gates both a forged creation modal and old report pagination', () => {
    expect(
      featureForInteraction(
        buildModalSubmitInteraction({ customId: 'giveaway_create|configured' }),
      ),
    ).toBe('giveaways');
    expect(featureForInteraction(buildButtonInteraction({ customId: 'level_page|1' }))).toBe(
      'reports',
    );
  });
  it('preserves existing participation while gating a new roll call', () => {
    expect(
      featureForInteraction(buildButtonInteraction({ customId: 'activity|join' })),
    ).toBeUndefined();
    expect(featureForInteraction(buildButtonInteraction({ customId: 'activity|rollcall' }))).toBe(
      'roll_call',
    );
  });
});
