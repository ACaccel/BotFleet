import {
  CATEGORIES,
  GuildSettingsError,
  type GuildSettings,
  type GuildSettingsActor,
  type GuildSettingsCategory,
} from '../../core/guild-settings';

export const canOpenSettings = (actor: GuildSettingsActor, settings: GuildSettings): boolean =>
  actor.manager ||
  settings.access.mode === 'everyone' ||
  (settings.access.mode === 'roles' &&
    actor.roleIds.some((role) => settings.access.roleIds.includes(role)));
export const categoryForPath = (path: string): GuildSettingsCategory | undefined => {
  if (path.startsWith('entertainment.')) return 'entertainment';
  if (path.startsWith('autoReply.')) return 'auto_reply';
  if (path.startsWith('socialPreview.') && path !== 'socialPreview.maxUrlsPerMessage')
    return 'social_preview';
  if (path.startsWith('features.')) {
    const feature = path.split('.')[1];
    return CATEGORIES.find((category) => category === feature);
  }
  return undefined;
};
export const assertSettingsAuthority = (
  actor: GuildSettingsActor,
  committed: GuildSettings,
  paths: readonly string[],
  next: GuildSettings = committed,
): void => {
  if (!canOpenSettings(actor, committed)) throw new GuildSettingsError('forbidden');
  const accessPaths = paths.filter((path) => path.startsWith('access.'));
  if (accessPaths.length > 0 && accessPaths.length !== paths.length)
    throw new GuildSettingsError('invalid', 'Access changes require a separate save');
  if (actor.manager) return;
  if (
    paths.includes('socialPreview.originalMessageStrategy') &&
    (committed.socialPreview.originalMessageStrategy === 'delete' ||
      next.socialPreview.originalMessageStrategy === 'delete')
  )
    throw new GuildSettingsError('forbidden');
  if (
    paths.some((path) => {
      const category = categoryForPath(path);
      return category === undefined || !committed.access.categories.includes(category);
    })
  )
    throw new GuildSettingsError('forbidden');
};
