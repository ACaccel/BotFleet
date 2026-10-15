import { describe, expect, it } from 'vitest';
import {
  EntertainmentGate,
  entertainmentCommandFor,
} from '../../../../src/application/guild-settings/entertainment';
import {
  defaultGuildSettings,
  FEATURES,
  type GuildSettingsRuntime,
  type OperatorCapabilities,
} from '../../../../src/core/guild-settings';
import { buildChatInputInteraction } from '../../../fixtures/discord/interaction-builder';

const capabilities: OperatorCapabilities = {
  features: Object.fromEntries(
    FEATURES.map((name) => [name, true]),
  ) as OperatorCapabilities['features'],
  socialProviders: [],
  maxRandomProbability: 1,
  minCooldownSeconds: 0,
  maxPreviewUrls: 5,
};
const settings = () => {
  const value = defaultGuildSettings(capabilities);
  value.entertainment.gay.cooldownSeconds = 10;
  const runtime: GuildSettingsRuntime = {
    get: (guildId) => ({
      botId: 'bot',
      guildId,
      revision: 0,
      settings: value,
      audit: [],
      lastOperationId: 'seed',
    }),
    isEnabled: () => true,
  };
  return { value, runtime };
};

describe('guild entertainment access', () => {
  it('isolates cooldowns by guild, member, command and application instance', () => {
    const { runtime } = settings();
    let now = 0;
    const gate = new EntertainmentGate(() => now);
    expect(gate.check(runtime, 'g1', 'u1', 'gay')).toEqual({ allowed: true });
    expect(gate.check(runtime, 'g1', 'u1', 'gay')).toEqual({
      allowed: false,
      reason: 'cooldown',
      seconds: 10,
    });
    expect(gate.check(runtime, 'g2', 'u1', 'gay')).toEqual({ allowed: true });
    expect(gate.check(runtime, 'g1', 'u2', 'gay')).toEqual({ allowed: true });
    expect(gate.check(runtime, 'g1', 'u1', 'give_score')).toEqual({ allowed: true });
    expect(new EntertainmentGate(() => now).check(runtime, 'g1', 'u1', 'gay')).toEqual({
      allowed: true,
    });
    now = 10000;
    expect(gate.check(runtime, 'g1', 'u1', 'gay')).toEqual({ allowed: true });
  });
  it('applies saved switches and zero cooldown without reserving a slot', () => {
    const { runtime, value } = settings();
    const gate = new EntertainmentGate();
    value.entertainment.gay.enabled = false;
    expect(gate.check(runtime, 'g1', 'u1', 'gay')).toEqual({ allowed: false, reason: 'disabled' });
    value.entertainment.gay.enabled = true;
    value.entertainment.gay.cooldownSeconds = 0;
    expect(gate.check(runtime, 'g1', 'u1', 'gay')).toEqual({ allowed: true });
    expect(gate.check(runtime, 'g1', 'u1', 'gay')).toEqual({ allowed: true });
  });
  it('fails closed for missing snapshots and bounded cooldown storage', () => {
    const { runtime } = settings();
    const gate = new EntertainmentGate(() => 0, 1);
    expect(gate.check({ ...runtime, get: () => undefined }, 'g1', 'u1', 'gay')).toEqual({
      allowed: false,
      reason: 'disabled',
    });
    expect(gate.check(runtime, 'g1', 'u1', 'gay')).toEqual({ allowed: true });
    expect(gate.check(runtime, 'g1', 'u2', 'gay')).toEqual({
      allowed: false,
      reason: 'cooldown',
      seconds: 10,
    });
    expect(gate.check(runtime, 'g1', 'u1', 'gay')).toEqual({
      allowed: false,
      reason: 'cooldown',
      seconds: 10,
    });
  });
  it('uses canonical context command IDs and ignores unrelated interactions', () => {
    const command = buildChatInputInteraction({ commandName: 'gay' });
    expect(entertainmentCommandFor(command)).toBe('gay');
    expect(entertainmentCommandFor(command, 'menu_get_avatar')).toBe('menu_get_avatar');
    expect(entertainmentCommandFor(command, 'help')).toBeUndefined();
    expect(
      entertainmentCommandFor({
        ...command,
        isChatInputCommand: () => false,
        isContextMenuCommand: () => false,
      } as typeof command),
    ).toBeUndefined();
  });
});
