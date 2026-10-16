import { ChannelType } from 'discord.js';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FEATURES,
  changedSettingsPaths,
  cloneSettings,
  defaultGuildSettings,
  type GuildSettingsActor,
  type OperatorCapabilities,
} from '../../../src/core/guild-settings';
import { I18NextTranslator } from '../../../src/core/i18n/i18next-translator';
import {
  boundedPanelLines,
  previewSettingsChanges,
  settingsFieldLabel,
  summarizeSettingsList,
} from '../../../src/application/guild-settings/panel-diff';
import { buildPanelModal } from '../../../src/application/guild-settings/panel-modal';
import { renderSettingsPanel } from '../../../src/application/guild-settings/panel-view';
import type { GuildSettingsSession } from '../../../src/application/guild-settings/session';
import enCommands from '../../../src/i18n/locales/en/commands.json';
import enReplies from '../../../src/i18n/locales/en/replies.json';
import enErrors from '../../../src/i18n/locales/en/errors.json';
import zhCommands from '../../../src/i18n/locales/zh-TW/commands.json';
import zhReplies from '../../../src/i18n/locales/zh-TW/replies.json';
import zhErrors from '../../../src/i18n/locales/zh-TW/errors.json';
const capabilities: OperatorCapabilities = {
  features: Object.fromEntries(
    FEATURES.map((value) => [value, true]),
  ) as OperatorCapabilities['features'],
  socialProviders: ['twitter', 'instagram'],
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
const oldChannel = '444444444444444444';
const newChannel = '555555555555555555';
const hiddenChannel = '666666666666666666';
const role = '777777777777777777';
let translator: I18NextTranslator;
beforeAll(async () => {
  translator = await I18NextTranslator.create({
    en: { commands: enCommands, replies: enReplies, errors: enErrors },
    'zh-TW': { commands: zhCommands, replies: zhReplies, errors: zhErrors },
  });
});
describe.each(['en', 'zh-TW'] as const)('settings differences in %s', (locale) => {
  const t = (key: string, params?: Record<string, string | number>): string =>
    translator.tStrict(`replies:settings.${key}`, params, locale);
  const resources = {
    visibleChannelIds: new Set([oldChannel, newChannel]),
    availableRoleIds: new Set([role]),
    manager: true,
  };
  it('shows concrete before/after channels even when array lengths stay the same', () => {
    const before = defaultGuildSettings(capabilities);
    before.features.auto_reply.channelIds = [oldChannel];
    const after = cloneSettings(before);
    after.features.auto_reply.channelIds = [newChannel];
    const result = previewSettingsChanges(
      before,
      after,
      changedSettingsPaths(before, after),
      t,
      resources,
    );
    expect(result).toContain(`<#${oldChannel}>`);
    expect(result).toContain(`<#${newChannel}>`);
    expect(result).toContain(t('feature.auto_reply'));
    expect(result).toContain(t('button.allowed'));
    expect(result).not.toContain('features.auto_reply.channelIds');
  });
  it('redacts unavailable channels and role IDs from delegated previews', () => {
    const before = defaultGuildSettings(capabilities);
    before.channels.event = hiddenChannel;
    before.access.roleIds = [role];
    const after = cloneSettings(before);
    after.channels.event = newChannel;
    after.access.roleIds = [];
    const result = previewSettingsChanges(before, after, changedSettingsPaths(before, after), t, {
      ...resources,
      manager: false,
    });
    expect(result).toContain(t('hidden_resource'));
    expect(result).not.toContain(hiddenChannel);
    expect(result).not.toContain(role);
    expect(result).toContain(`<#${newChannel}>`);
  });
  it('shows manager role references, percentages, modes and platform names', () => {
    const before = defaultGuildSettings(capabilities);
    before.autoReply.probability = 0.005;
    const after = cloneSettings(before);
    after.autoReply.probability = 0.01;
    after.access.mode = 'roles';
    after.access.roleIds = [role];
    after.access.categories = ['auto_reply'];
    after.features.auto_reply.mode = 'allowlist';
    after.socialPreview.originalMessageStrategy = 'leave';
    after.socialPreview.providers = ['twitter'];
    after.autoReply.random = false;
    after.channels.debug = oldChannel;
    const result = previewSettingsChanges(
      before,
      after,
      changedSettingsPaths(before, after),
      t,
      resources,
    );
    for (const text of [
      '0.5%',
      '1%',
      `<@&${role}>`,
      t('parameter.probability'),
      t('mode.roles'),
      t('grant.auto_reply'),
      t('allowlist'),
      t('strategies.leave'),
      t('provider.twitter'),
      t('disabled'),
      t('destination.debug'),
    ])
      expect(result).toContain(text);
    expect(result).not.toContain('autoReply.');
    expect(result).not.toContain('socialPreview.');
  });
  it('bounds previews using complete rows and announces omitted changes', () => {
    const lines = Array.from({ length: 10 }, (_, index) => `${index}: ${'x'.repeat(790)}`);
    const result = boundedPanelLines(lines, t);
    expect(result.length).toBeLessThanOrEqual(3000);
    expect(result).toContain(lines[0]);
    expect(result).toContain(lines[1]);
    expect(result).toContain(lines[2]);
    expect(result).not.toContain('3:');
    expect(result).toContain(t('preview_truncated', { count: 7 }));
  });
  it('states array omissions and handles empty or unknown settings safely', () => {
    expect(
      summarizeSettingsList(
        Array.from({ length: 10 }, (_, index) => String(index)),
        t,
      ),
    ).toContain(t('more_items', { count: 2 }));
    expect(summarizeSettingsList([], t)).toBe(t('not_set'));
    expect(settingsFieldLabel('malicious.private.path', t)).toBe(t('unknown_setting'));
    const settings = defaultGuildSettings(capabilities);
    expect(previewSettingsChanges(settings, settings, [], t, resources)).toBe(t('no_changes'));
  });
  it('translates every schema leaf field in history', () => {
    const settings = defaultGuildSettings(capabilities);
    const fields = [
      ...FEATURES.flatMap((feature) =>
        Object.keys(settings.features[feature]).map((key) => `features.${feature}.${key}`),
      ),
      ...['access', 'channels', 'autoReply', 'socialPreview', 'general', 'moderationVote'].flatMap(
        (section) =>
          Object.keys(settings[section as keyof typeof settings]).map((key) => `${section}.${key}`),
      ),
    ];
    fields.push(
      ...Object.entries(settings.entertainment).flatMap(([command, values]) =>
        Object.keys(values).map((key) => `entertainment.${command}.${key}`),
      ),
    );
    for (const path of fields) expect(settingsFieldLabel(path, t)).not.toBe(t('unknown_setting'));
    const session: GuildSettingsSession = {
      id: 'opaque_session',
      botId: actor.botId,
      guildId: actor.guildId,
      userId: actor.userId,
      expiresAt: Date.now() + 600000,
      baseRevision: 0,
      base: settings,
      draft: cloneSettings(settings),
      pending: false,
      saving: false,
    };
    const page = renderSettingsPanel(
      session,
      actor,
      capabilities,
      t,
      'history',
      undefined,
      'debug',
      undefined,
      [
        {
          revision: 1,
          userId: actor.userId,
          paths: ['autoReply.probability', 'features.auto_reply.channelIds'],
        },
      ],
    );
    const text = JSON.stringify(page);
    expect(text).toContain(t('parameter.probability'));
    expect(text).toContain(t('feature.auto_reply'));
    expect(text).not.toContain('autoReply.probability');
    expect(text).not.toContain('features.auto_reply.channelIds');
  });
});
describe('native feature scope choices', () => {
  it('supports forum/media parents and voice/stage chats without widening output destinations', () => {
    const settings = defaultGuildSettings(capabilities);
    const session: GuildSettingsSession = {
      id: 'opaque_session',
      botId: actor.botId,
      guildId: actor.guildId,
      userId: actor.userId,
      expiresAt: Date.now() + 600000,
      baseRevision: 0,
      base: settings,
      draft: cloneSettings(settings),
      pending: false,
      saving: false,
    };
    const t = (key: string) => key.split('.').pop() ?? key;
    const scope = buildPanelModal(
      session,
      'scope_auto_reply',
      'nonce',
      true,
      capabilities,
      t,
    ).toJSON();
    const selectors = scope.components.flatMap((label) =>
      'component' in label && 'channel_types' in label.component ? [label.component] : [],
    );
    expect(selectors).toHaveLength(2);
    for (const selector of selectors)
      expect(selector.channel_types).toEqual(
        expect.arrayContaining([
          ChannelType.GuildForum,
          ChannelType.GuildMedia,
          ChannelType.GuildVoice,
          ChannelType.GuildStageVoice,
        ]),
      );
    const destinations = buildPanelModal(
      session,
      'channels',
      'nonce',
      true,
      capabilities,
      t,
    ).toJSON();
    expect(destinations.components).toHaveLength(3);
    for (const label of destinations.components)
      if ('component' in label && 'channel_types' in label.component)
        expect(label.component.channel_types).toEqual([
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
        ]);
  });
});
