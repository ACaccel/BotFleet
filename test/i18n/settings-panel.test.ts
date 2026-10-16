import { beforeAll, describe, expect, it } from 'vitest';
import {
  FEATURES,
  defaultGuildSettings,
  type GuildSettingsActor,
  type OperatorCapabilities,
} from '../../src/core/guild-settings';
import { I18NextTranslator } from '../../src/core/i18n/i18next-translator';
import { renderSettingsPanel } from '../../src/application/guild-settings/panel-view';
import { buildPanelModal } from '../../src/application/guild-settings/panel-modal';
import type { GuildSettingsSession } from '../../src/application/guild-settings/session';
import enCommands from '../../src/i18n/locales/en/commands.json';
import enReplies from '../../src/i18n/locales/en/replies.json';
import enErrors from '../../src/i18n/locales/en/errors.json';
import zhCommands from '../../src/i18n/locales/zh-TW/commands.json';
import zhReplies from '../../src/i18n/locales/zh-TW/replies.json';
import zhErrors from '../../src/i18n/locales/zh-TW/errors.json';
const capabilities: OperatorCapabilities = {
  earthquake: { alerts: true, reports: true },
  features: Object.fromEntries(
    FEATURES.map((value) => [value, true]),
  ) as OperatorCapabilities['features'],
  socialProviders: ['twitter', 'instagram', 'threads', 'facebook', 'reddit', 'bahamut', 'bilibili'],
  maxRandomProbability: 0.5,
  minCooldownSeconds: 1,
  maxPreviewUrls: 10,
};
const actor: GuildSettingsActor = {
  botId: '111111111111111111',
  guildId: '222222222222222222',
  userId: '333333333333333333',
  manager: true,
  roleIds: [],
};
let translator: I18NextTranslator;
beforeAll(async () => {
  translator = await I18NextTranslator.create({
    en: { commands: enCommands, replies: enReplies, errors: enErrors },
    'zh-TW': { commands: zhCommands, replies: zhReplies, errors: zhErrors },
  });
});
const session: GuildSettingsSession = {
  id: 'opaque_session',
  botId: actor.botId,
  guildId: actor.guildId,
  userId: actor.userId,
  expiresAt: Date.now() + 600000,
  baseRevision: 0,
  base: defaultGuildSettings(capabilities),
  draft: defaultGuildSettings(capabilities),
  pending: false,
  saving: false,
};
describe.each(['en', 'zh-TW'] as const)('settings panel in %s', (locale) => {
  const t = (key: string, params?: Record<string, string | number>): string =>
    translator.tStrict(`replies:settings.${key}`, params, locale);
  it.each([
    'general',
    'access',
    'features',
    'channels',
    'auto_reply',
    'social',
    'entertainment',
    'moderation',
    'earthquake',
    'status',
    'history',
  ] as const)('resolves every %s page string and validates builders', (category) => {
    const page = renderSettingsPanel(session, actor, capabilities, t, category);
    expect(page.embeds?.[0]).toBeDefined();
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain('replies:settings.');
    expect(serialized).not.toContain('Tomori');
  });
  it.each([
    'access',
    'channels',
    'general',
    'auto_reply',
    'social',
    'moderation',
    'earthquake',
    'scope_auto_reply',
    'entertainment_menu_author_avatar',
  ] as const)('resolves every %s modal label', (category) => {
    const modal = buildPanelModal(session, category, 'nonce', true, capabilities, t).toJSON();
    expect(modal.components.length).toBeLessThanOrEqual(5);
    expect(modal.custom_id.length).toBeLessThanOrEqual(100);
    for (const label of modal.components)
      if (
        'component' in label &&
        'min_values' in label.component &&
        label.component.min_values === 0
      )
        expect(label.component.required).toBe(false);
    if (
      category === 'auto_reply' ||
      category === 'social' ||
      category.startsWith('scope_') ||
      category.startsWith('entertainment_')
    )
      expect(
        buildPanelModal(session, category, 'nonce', false, capabilities, t).toJSON().components
          .length,
      ).toBeLessThanOrEqual(5);
  });
  it('includes command help and every user error', () => {
    for (const key of [
      'forbidden',
      'expired',
      'invalid',
      'conflict',
      'unavailable',
      'pending',
      'guild_only',
      'failed',
    ])
      expect(translator.tStrict(`errors:settings.${key}`, undefined, locale)).toBeTruthy();
    expect(translator.tStrict('commands:settings.description', undefined, locale)).toBeTruthy();
    expect(translator.tStrict('commands:settings.description', undefined, locale)).not.toContain(
      'Tomori',
    );
    expect(translator.tStrict('replies:help.details.settings', undefined, locale)).toBeTruthy();
  });
});
