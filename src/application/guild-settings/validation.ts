import {
  FEATURES,
  GuildSettingsError,
  guildSettingsSchema,
  guildSettingsDraftSchema,
  type GuildSettings,
  type GuildSettingsActor,
  type OperatorCapabilities,
} from '../../core/guild-settings';

export const validateSettings = (
  value: unknown,
  capabilities: OperatorCapabilities,
  actor?: GuildSettingsActor,
  previous?: GuildSettings,
  options: { readonly allowIncompleteAccess?: boolean } = {},
): GuildSettings => {
  const schema = options.allowIncompleteAccess ? guildSettingsDraftSchema : guildSettingsSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new GuildSettingsError('invalid', 'Invalid settings schema');
  const settings = parsed.data;
  if (
    FEATURES.some(
      (feature) =>
        settings.features[feature].enabled &&
        !capabilities.features[feature] &&
        previous?.features[feature].enabled !== true,
    ) ||
    settings.socialPreview.providers.some(
      (provider) =>
        !capabilities.socialProviders.includes(provider) &&
        !previous?.socialPreview.providers.includes(provider),
    ) ||
    (settings.autoReply.probability > capabilities.maxRandomProbability &&
      settings.autoReply.probability !== previous?.autoReply.probability) ||
    (settings.autoReply.cooldownSeconds < capabilities.minCooldownSeconds &&
      settings.autoReply.cooldownSeconds !== previous?.autoReply.cooldownSeconds) ||
    (settings.socialPreview.maxUrlsPerMessage > capabilities.maxPreviewUrls &&
      settings.socialPreview.maxUrlsPerMessage !== previous?.socialPreview.maxUrlsPerMessage) ||
    (actor &&
      (settings.access.roleIds.includes(actor.guildId) ||
        settings.moderationVote.voterRoleIds.includes(actor.guildId) ||
        settings.earthquake.roleId === actor.guildId)) ||
    (['alerts', 'reports'] as const).some((kind) => {
      const key = kind === 'alerts' ? 'alertsEnabled' : 'reportsEnabled';
      return (
        settings.earthquake[key] && !capabilities.earthquake?.[kind] && !previous?.earthquake[key]
      );
    }) ||
    ((settings.earthquake.alertsEnabled || settings.earthquake.reportsEnabled) &&
      settings.earthquake.channelId === null)
  ) {
    throw new GuildSettingsError('invalid', 'Settings exceed deployment capabilities');
  }
  return settings;
};
