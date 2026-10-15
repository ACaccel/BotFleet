import { ENTERTAINMENT_COMMANDS, FEATURES, type GuildSettings } from '../../core/guild-settings';

export type SettingsDiffTranslate = (
  key: string,
  params?: Record<string, string | number>,
) => string;
export interface SettingsDiffResources {
  readonly visibleChannelIds: ReadonlySet<string>;
  readonly availableRoleIds: ReadonlySet<string>;
  readonly manager: boolean;
}
const AUTO_PARAMETERS = [
  'keywords',
  'lucky',
  'random',
  'dice',
  'reactions',
  'probability',
  'cooldownSeconds',
];
const SOCIAL_PARAMETERS = [
  'providers',
  'originalMessageStrategy',
  'maxUrlsPerMessage',
  'videoEnabled',
];
export const settingsFieldLabel = (path: string, t: SettingsDiffTranslate): string => {
  const [section, name, parameter, extra] = path.split('.');
  if (extra !== undefined) return t('unknown_setting');
  if (section === 'features' && FEATURES.some((feature) => feature === name)) {
    const label = t(`feature.${name}`);
    const suffix =
      parameter === 'mode'
        ? t('button.scope')
        : parameter === 'channelIds'
          ? t('button.allowed')
          : parameter === 'excludedChannelIds'
            ? t('button.excluded')
            : undefined;
    return parameter === 'enabled' ? label : suffix ? `${label} · ${suffix}` : t('unknown_setting');
  }
  if (
    section === 'entertainment' &&
    ENTERTAINMENT_COMMANDS.some((command) => command === name) &&
    ['enabled', 'cooldownSeconds'].includes(parameter ?? '')
  )
    return `${t(`entertainment_command.${name}`)} · ${t(parameter === 'enabled' ? 'enabled' : 'cooldown')}`;
  if (parameter !== undefined) return t('unknown_setting');
  if (section === 'general' && ['language', 'timeZone'].includes(name ?? ''))
    return t(`parameter.${name}`);
  if (
    section === 'moderationVote' &&
    ['threshold', 'voteWindowSeconds', 'durationMinutes', 'voterRoleIds'].includes(name ?? '')
  )
    return t(`parameter.${name}`);
  if (section === 'access')
    return name === 'mode'
      ? t('audience')
      : name === 'roleIds'
        ? t('role_placeholder')
        : name === 'categories'
          ? t('grants')
          : t('unknown_setting');
  if (section === 'channels' && ['debug', 'event', 'giveaway'].includes(name ?? ''))
    return t(`destination.${name}`);
  if (section === 'autoReply' && AUTO_PARAMETERS.includes(name ?? ''))
    return t(`parameter.${name}`);
  if (section === 'socialPreview' && SOCIAL_PARAMETERS.includes(name ?? ''))
    return t(`parameter.${name}`);
  return t('unknown_setting');
};
export const summarizeSettingsList = (
  values: readonly string[],
  t: SettingsDiffTranslate,
): string => {
  if (values.length === 0) return t('not_set');
  const shown = values.slice(0, 8);
  if (values.length > shown.length)
    shown.push(t('more_items', { count: values.length - shown.length }));
  return shown.join(', ');
};
const readPath = (settings: GuildSettings, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (value, key) =>
        value !== null && typeof value === 'object'
          ? (value as Record<string, unknown>)[key]
          : undefined,
      settings,
    );
const fieldValue = (
  path: string,
  value: unknown,
  t: SettingsDiffTranslate,
  resources: SettingsDiffResources,
): string => {
  if (value === null) return t('not_set');
  if (typeof value === 'boolean') return t(value ? 'enabled' : 'disabled');
  if (typeof value === 'number')
    return path === 'autoReply.probability'
      ? `${Number((value * 100).toPrecision(12))}%`
      : String(value);
  if (Array.isArray(value)) {
    const values = value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => {
        if (path.endsWith('.channelIds') || path.endsWith('.excludedChannelIds'))
          return resources.visibleChannelIds.has(entry) ? `<#${entry}>` : t('hidden_resource');
        if (path === 'access.roleIds' || path === 'moderationVote.voterRoleIds')
          return resources.manager && resources.availableRoleIds.has(entry)
            ? `<@&${entry}>`
            : t('hidden_resource');
        if (path === 'access.categories') return t(`grant.${entry}`);
        if (path === 'socialPreview.providers') return t(`provider.${entry}`);
        return t('unknown_setting');
      });
    return summarizeSettingsList(values, t);
  }
  if (typeof value === 'string') {
    if (path === 'general.language') return t(`language.${value}`);
    if (path === 'general.timeZone') return value;
    if (path.startsWith('channels.'))
      return resources.visibleChannelIds.has(value) ? `<#${value}>` : t('hidden_resource');
    if (path === 'access.mode') return t(`mode.${value}`);
    if (path.endsWith('.mode')) return t(value);
    if (path === 'socialPreview.originalMessageStrategy') return t(`strategies.${value}`);
  }
  return t('unknown_setting');
};
export const boundedPanelLines = (
  lines: readonly string[],
  t: SettingsDiffTranslate,
  maximum = 3000,
  truncationKey = 'preview_truncated',
): string => {
  const shown: string[] = [];
  for (const line of lines) {
    const remaining = lines.length - shown.length - 1;
    const candidate = [
      ...shown,
      line,
      ...(remaining > 0 ? [t(truncationKey, { count: remaining })] : []),
    ].join('\n');
    if (candidate.length > maximum) break;
    shown.push(line);
  }
  const remaining = lines.length - shown.length;
  if (remaining > 0) shown.push(t(truncationKey, { count: remaining }));
  return shown.join('\n');
};
export const previewSettingsChanges = (
  before: GuildSettings,
  after: GuildSettings,
  paths: readonly string[],
  t: SettingsDiffTranslate,
  resources: SettingsDiffResources,
): string => {
  const lines = paths.map((path) =>
    t('diff', {
      field: settingsFieldLabel(path, t),
      before: fieldValue(path, readPath(before, path), t, resources),
      after: fieldValue(path, readPath(after, path), t, resources),
    }),
  );
  return lines.length > 0 ? boundedPanelLines(lines, t) : t('no_changes');
};
