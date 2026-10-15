import { describe, expect, it } from 'vitest';
import {
  ENTERTAINMENT_COMMANDS,
  FEATURES,
  defaultGuildSettings,
  guildSettingsSchema,
  normalizeGuildSettings,
  upgradeGuildSettings,
  type OperatorCapabilities,
} from '../../../src/core/guild-settings';
const capabilities: OperatorCapabilities = {
  features: Object.fromEntries(FEATURES.map((feature) => [feature, true])) as Record<
    (typeof FEATURES)[number],
    boolean
  >,
  socialProviders: ['x'],
  maxRandomProbability: 0.05,
  minCooldownSeconds: 2,
  maxPreviewUrls: 5,
};
const legacySettings = () => {
  const {
    general: _general,
    entertainment: _entertainment,
    moderationVote: _moderation,
    ...legacy
  } = defaultGuildSettings(capabilities);
  return legacy;
};
describe('guild settings v2 model', () => {
  it.each([1, 2, 3])(
    'upgrades version %s with independent, disabled earthquake preferences',
    (version) => {
      const { earthquake: _earthquake, ...stored } = defaultGuildSettings(capabilities);
      const upgraded = upgradeGuildSettings(version, stored);
      expect(upgraded.earthquake).toEqual({
        alertsEnabled: false,
        reportsEnabled: false,
        channelId: null,
        roleId: null,
      });
      upgraded.earthquake.alertsEnabled = true;
      expect(upgradeGuildSettings(version, stored).earthquake.alertsEnabled).toBe(false);
    },
  );
  it('preserves current earthquake choices and validates optional resources', () => {
    const settings = defaultGuildSettings(capabilities);
    settings.earthquake = {
      alertsEnabled: true,
      reportsEnabled: false,
      channelId: '400000000000000001',
      roleId: null,
    };
    expect(normalizeGuildSettings(settings).earthquake).toEqual(settings.earthquake);
    expect(() =>
      normalizeGuildSettings({
        ...settings,
        earthquake: { ...settings.earthquake, roleId: 'invalid' },
      }),
    ).toThrow();
  });
  it('normalizes old payloads with inherited locale and independent command defaults', () => {
    const normalized = normalizeGuildSettings(legacySettings());
    expect(normalized.general).toEqual({ language: 'inherit', timeZone: null });
    expect(normalized.moderationVote).toEqual({
      threshold: 5,
      voteWindowSeconds: 60,
      durationMinutes: 1,
      voterRoleIds: [],
    });
    expect(Object.keys(normalized.entertainment)).toEqual([...ENTERTAINMENT_COMMANDS]);
    for (const command of ENTERTAINMENT_COMMANDS)
      expect(normalized.entertainment[command]).toEqual({ enabled: true, cooldownSeconds: 0 });
    normalized.entertainment.gay.cooldownSeconds = 10;
    expect(normalized.entertainment.give_score.cooldownSeconds).toBe(0);
    expect(normalizeGuildSettings(legacySettings()).entertainment.gay.cooldownSeconds).toBe(0);
  });
  it.each([1, 2, 3])('removes the retired targeted-reply flag from version %s', (version) => {
    const stored = version === 1 ? legacySettings() : defaultGuildSettings(capabilities);
    const old = { ...stored, autoReply: { ...stored.autoReply, lucky: true } };
    const normalized = upgradeGuildSettings(version, old);
    expect(normalized.autoReply).not.toHaveProperty('lucky');
    expect(normalized.autoReply.random).toBe(true);
    expect(old.autoReply.lucky).toBe(true);
    expect(normalizeGuildSettings(old).autoReply).not.toHaveProperty('lucky');
    expect(() =>
      normalizeGuildSettings({
        ...old,
        autoReply: { ...old.autoReply, unknown: true },
      }),
    ).toThrow();
  });
  it.each(['Asia/Taipei', 'Europe/London', 'UTC'])('accepts the IANA time zone %s', (timeZone) => {
    const settings = defaultGuildSettings(capabilities);
    settings.general = { language: 'zh-TW', timeZone };
    expect(normalizeGuildSettings(settings).general).toEqual({ language: 'zh-TW', timeZone });
  });
  it.each(['Mars/Olympus', '+08:00', 'UTC+8', '', ' Asia/Taipei'])(
    'rejects invalid time zone %s early',
    (timeZone) => {
      const settings = defaultGuildSettings(capabilities);
      settings.general.timeZone = timeZone;
      expect(guildSettingsSchema.safeParse(settings).success).toBe(false);
    },
  );
  it('rejects unknown commands, fractional cooldowns and out-of-range vote policies', () => {
    const settings = defaultGuildSettings(capabilities);
    expect(
      guildSettingsSchema.safeParse({
        ...settings,
        entertainment: {
          ...settings.entertainment,
          unknown: { enabled: true, cooldownSeconds: 0 },
        },
      }).success,
    ).toBe(false);
    settings.entertainment.gay.cooldownSeconds = 0.5;
    expect(guildSettingsSchema.safeParse(settings).success).toBe(false);
    settings.entertainment.gay.cooldownSeconds = 0;
    for (const moderationVote of [
      { ...settings.moderationVote, threshold: 1 },
      { ...settings.moderationVote, threshold: 51 },
      { ...settings.moderationVote, voteWindowSeconds: 9 },
      { ...settings.moderationVote, voteWindowSeconds: 601 },
      { ...settings.moderationVote, durationMinutes: 6 },
      { ...settings.moderationVote, voterRoleIds: ['foreign'] },
    ])
      expect(guildSettingsSchema.safeParse({ ...settings, moderationVote }).success).toBe(false);
  });
});

describe('guild settings v3 upgrade', () => {
  it('adds the gallery providers to records stored before version 3, once', () => {
    const stored = defaultGuildSettings(capabilities);
    stored.socialPreview.providers = ['x', 'wnacg'];
    expect(upgradeGuildSettings(2, stored).socialPreview.providers).toEqual([
      'x',
      'wnacg',
      'nhentai',
    ]);
    expect(upgradeGuildSettings(1, legacySettings()).socialPreview.providers).toEqual([
      'x',
      'nhentai',
      'wnacg',
    ]);
  });

  it('leaves current records as saved, including an opt-out', () => {
    const stored = defaultGuildSettings(capabilities);
    stored.socialPreview.providers = [];
    expect(upgradeGuildSettings(3, stored).socialPreview.providers).toEqual([]);
  });
});
