import {
  ChannelSelectMenuBuilder,
  ChannelType,
  ComponentType,
  LabelBuilder,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
} from 'discord.js';
import {
  CATEGORIES,
  ENTERTAINMENT_COMMANDS,
  FEATURES,
  GuildSettingsError,
  type EntertainmentCommand,
  type GuildFeature,
  type GuildSettings,
  type OperatorCapabilities,
} from '../../core/guild-settings';
import type { GuildSettingsSession } from './session';
import type { PanelTranslate } from './panel-view';
import { panelId } from './panel-id';
export const DESTINATION_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
] as const;
export const SCOPE_CHANNEL_TYPES = [
  ...DESTINATION_CHANNEL_TYPES,
  ChannelType.GuildCategory,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
] as const;
export type PanelModalContext =
  | 'access'
  | 'channels'
  | 'general'
  | 'auto_reply'
  | 'social'
  | 'moderation'
  | 'earthquake'
  | `scope_${GuildFeature}`
  | `entertainment_${EntertainmentCommand}`;
export const parseModalContext = (value: string): PanelModalContext | undefined => {
  if (
    ['access', 'channels', 'general', 'auto_reply', 'social', 'moderation', 'earthquake'].includes(
      value,
    )
  )
    return value as PanelModalContext;
  if (
    FEATURES.some((feature) => value === `scope_${feature}`) ||
    ENTERTAINMENT_COMMANDS.some((command) => value === `entertainment_${command}`)
  )
    return value as PanelModalContext;
  return undefined;
};
export interface PanelModalResources {
  readonly visibleChannelIds?: ReadonlySet<string>;
  readonly availableRoleIds?: ReadonlySet<string>;
}
const text = (
  id: string,
  value: string | number,
  label: string,
  required = true,
  maximum = 24,
): LabelBuilder =>
  new LabelBuilder()
    .setLabel(label)
    .setTextInputComponent(
      new TextInputBuilder()
        .setCustomId(id)
        .setStyle(TextInputStyle.Short)
        .setRequired(required)
        .setMaxLength(maximum)
        .setValue(String(value)),
    );
const select = (
  id: string,
  label: string,
  choices: readonly { label: string; value: string; default: boolean }[],
  multiple = false,
): LabelBuilder =>
  new LabelBuilder().setLabel(label).setStringSelectMenuComponent(
    new StringSelectMenuBuilder()
      .setCustomId(id)
      .setMinValues(multiple ? 0 : 1)
      .setRequired(!multiple)
      .setMaxValues(multiple ? choices.length : 1)
      .addOptions(...choices),
  );
const toggles = (id: string, label: string, enabled: boolean, t: PanelTranslate): LabelBuilder =>
  select(
    id,
    label,
    ['on', 'off'].map((value) => ({
      label: t(value === 'on' ? 'enabled' : 'disabled'),
      value,
      default: (value === 'on') === enabled,
    })),
  );
const channels = (
  id: string,
  label: string,
  values: readonly string[],
  resources: PanelModalResources,
  destination = false,
): LabelBuilder =>
  new LabelBuilder().setLabel(label).setChannelSelectMenuComponent(
    new ChannelSelectMenuBuilder()
      .setCustomId(id)
      .setChannelTypes(...(destination ? DESTINATION_CHANNEL_TYPES : SCOPE_CHANNEL_TYPES))
      .setMinValues(0)
      .setMaxValues(destination ? 1 : 25)
      .setRequired(false)
      .setDefaultChannels(
        values.filter((value) => resources.visibleChannelIds?.has(value) ?? true),
      ),
  );
const roles = (
  id: string,
  label: string,
  values: readonly string[],
  resources: PanelModalResources,
  maximum = 25,
): LabelBuilder =>
  new LabelBuilder().setLabel(label).setRoleSelectMenuComponent(
    new RoleSelectMenuBuilder()
      .setCustomId(id)
      .setMinValues(0)
      .setMaxValues(maximum)
      .setRequired(false)
      .setDefaultRoles(values.filter((value) => resources.availableRoleIds?.has(value) ?? true)),
  );
export const buildPanelModal = (
  session: GuildSettingsSession,
  context: PanelModalContext,
  nonce: string,
  manager: boolean,
  capabilities: OperatorCapabilities,
  t: PanelTranslate,
  resources: PanelModalResources = {},
): ModalBuilder => {
  const labels: LabelBuilder[] = [];
  const modalType = context.startsWith('scope_')
    ? 'scope'
    : context.startsWith('entertainment_')
      ? 'entertainment'
      : context === 'auto_reply'
        ? 'auto'
        : context;
  let title = t(`modal_${modalType}`);
  const setting = session.draft;
  if (context === 'earthquake') {
    if (!manager || !capabilities.earthquake) throw new GuildSettingsError('forbidden');
    for (const kind of ['alerts', 'reports'] as const) {
      const key = kind === 'alerts' ? 'alertsEnabled' : 'reportsEnabled';
      labels.push(
        select(
          kind,
          t(`parameter.${key}`),
          (capabilities.earthquake[kind] ? ['on', 'off'] : ['off']).map((value) => ({
            label: t(value === 'on' ? 'enabled' : 'disabled'),
            value,
            default: (value === 'on') === setting.earthquake[key],
          })),
        ),
      );
    }
    labels.push(
      channels(
        'earthquake_channel',
        t('parameter.earthquakeChannelId'),
        setting.earthquake.channelId ? [setting.earthquake.channelId] : [],
        resources,
        true,
      ),
      roles(
        'earthquake_role',
        t('parameter.earthquakeRoleId'),
        setting.earthquake.roleId ? [setting.earthquake.roleId] : [],
        resources,
        1,
      ),
    );
  } else if (context === 'auto_reply') {
    title = t('modal_auto');
    labels.push(
      text(
        'probability',
        Number((setting.autoReply.probability * 100).toPrecision(12)),
        t('probability'),
      ),
      text('cooldown', setting.autoReply.cooldownSeconds, t('cooldown')),
      select(
        'behaviors',
        t('behaviors'),
        (['keywords', 'random', 'dice', 'reactions'] as const).map((value) => ({
          label: t(`behavior.${value}`),
          value,
          default: setting.autoReply[value],
        })),
        true,
      ),
    );
  } else if (context === 'social') {
    labels.push(toggles('video', t('video'), setting.socialPreview.videoEnabled, t));
    if (capabilities.socialProviders.length > 0)
      labels.push(
        select(
          'providers',
          t('providers'),
          capabilities.socialProviders.map((value) => ({
            label: t(`provider.${value}`),
            value,
            default: setting.socialPreview.providers.includes(value),
          })),
          true,
        ),
      );
    if (manager || setting.socialPreview.originalMessageStrategy !== 'delete')
      labels.push(
        select(
          'strategy',
          t('strategy'),
          (manager ? ['leave', 'suppress', 'delete'] : ['leave', 'suppress']).map((value) => ({
            label: t(`strategies.${value}`),
            value,
            default: value === setting.socialPreview.originalMessageStrategy,
          })),
        ),
      );
    if (manager)
      labels.push(
        text('max_urls', setting.socialPreview.maxUrlsPerMessage, t('max_urls')).setDescription(
          t('max_urls_range', { max: Math.min(5, capabilities.maxPreviewUrls) }),
        ),
      );
  } else if (context === 'access') {
    labels.push(
      select(
        'audience',
        t('audience'),
        ['managers', 'roles', 'everyone'].map((value) => ({
          label: t(`mode.${value}`),
          value,
          default: value === setting.access.mode,
        })),
      ),
      roles('roles', t('roles'), setting.access.roleIds, resources),
      select(
        'grants',
        t('grants'),
        CATEGORIES.map((value) => ({
          label: t(`grant.${value}`),
          value,
          default: setting.access.categories.includes(value),
        })),
        true,
      ),
    );
  } else if (context === 'channels') {
    for (const destination of ['debug', 'event', 'giveaway'] as const)
      labels.push(
        channels(
          destination,
          t(`destination.${destination}`),
          setting.channels[destination] ? [setting.channels[destination]] : [],
          resources,
          true,
        ),
      );
  } else if (context === 'general') {
    labels.push(
      select(
        'language',
        t('parameter.language'),
        ['inherit', 'en', 'zh-TW'].map((value) => ({
          label: t(`language.${value}`),
          value,
          default: value === setting.general.language,
        })),
      ),
      text(
        'time_zone',
        setting.general.timeZone ?? '',
        t('parameter.timeZone'),
        false,
        100,
      ).setDescription(t('time_zone_hint')),
    );
  } else if (context === 'moderation') {
    labels.push(
      text('threshold', setting.moderationVote.threshold, t('parameter.threshold')).setDescription(
        t('threshold_range'),
      ),
      text(
        'window',
        setting.moderationVote.voteWindowSeconds,
        t('parameter.voteWindowSeconds'),
      ).setDescription(t('vote_window_range')),
      text(
        'duration',
        setting.moderationVote.durationMinutes,
        t('parameter.durationMinutes'),
      ).setDescription(t('duration_range')),
      roles(
        'voter_roles',
        t('parameter.voterRoleIds'),
        setting.moderationVote.voterRoleIds,
        resources,
      ).setDescription(t('voter_roles_hint')),
    );
  } else if (context.startsWith('scope_')) {
    const feature = context.slice('scope_'.length) as GuildFeature;
    title = t('modal_scope');
    const scope = setting.features[feature];
    labels.push(
      select(
        'mode',
        t('button.scope'),
        ['all', 'allowlist'].map((value) => ({
          label: t(value),
          value,
          default: value === scope.mode,
        })),
      ),
      channels('allowed', t('button.allowed'), scope.channelIds, resources),
      channels('excluded', t('button.excluded'), scope.excludedChannelIds, resources),
    );
  } else {
    const command = context.slice('entertainment_'.length) as EntertainmentCommand;
    title = t('modal_entertainment');
    labels.push(
      toggles(
        'enabled',
        t(`entertainment_command.${command}`),
        setting.entertainment[command].enabled,
        t,
      ),
      text(
        'cooldown',
        setting.entertainment[command].cooldownSeconds,
        t('cooldown'),
      ).setDescription(t('cooldown_range')),
    );
  }
  return new ModalBuilder()
    .setCustomId(panelId(session.id, 'modal', context, nonce))
    .setTitle(title)
    .setLabelComponents(...labels);
};
const numeric = (value: string): number => {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))
    throw new GuildSettingsError('invalid');
  const result = Number(value);
  if (!Number.isFinite(result)) throw new GuildSettingsError('invalid');
  return result;
};
export const modalResourceValues = (
  interaction: Pick<ModalSubmitInteraction, 'fields'>,
  id: string,
  type: ComponentType.ChannelSelect | ComponentType.RoleSelect,
): string[] => {
  const field = interaction.fields.getField(id);
  if (field.type !== type || !('values' in field)) throw new GuildSettingsError('invalid');
  return [...field.values];
};
const choice = (
  interaction: Pick<ModalSubmitInteraction, 'fields'>,
  id: string,
  choices: readonly string[],
): string => {
  const values = interaction.fields.getStringSelectValues(id);
  if (values.length !== 1 || !choices.includes(values[0] ?? ''))
    throw new GuildSettingsError('invalid');
  return values[0] as string;
};
export const applyPanelModal = (
  draft: GuildSettings,
  interaction: Pick<ModalSubmitInteraction, 'fields'>,
  context: PanelModalContext,
  manager: boolean,
  capabilities: OperatorCapabilities,
): void => {
  if (['access', 'channels', 'general', 'moderation', 'earthquake'].includes(context) && !manager)
    throw new GuildSettingsError('forbidden');
  if (context === 'earthquake') {
    if (!capabilities.earthquake) throw new GuildSettingsError('forbidden');
    for (const kind of ['alerts', 'reports'] as const) {
      const key = kind === 'alerts' ? 'alertsEnabled' : 'reportsEnabled';
      draft.earthquake[key] =
        choice(interaction, kind, capabilities.earthquake[kind] ? ['on', 'off'] : ['off']) === 'on';
    }
    const channelIds = modalResourceValues(
      interaction,
      'earthquake_channel',
      ComponentType.ChannelSelect,
    );
    const roleIds = modalResourceValues(interaction, 'earthquake_role', ComponentType.RoleSelect);
    if (channelIds.length > 1 || roleIds.length > 1) throw new GuildSettingsError('invalid');
    draft.earthquake.channelId = channelIds[0] ?? null;
    draft.earthquake.roleId = roleIds[0] ?? null;
  } else if (context === 'auto_reply') {
    draft.autoReply.probability =
      numeric(interaction.fields.getTextInputValue('probability')) / 100;
    draft.autoReply.cooldownSeconds = numeric(interaction.fields.getTextInputValue('cooldown'));
    const values = interaction.fields.getStringSelectValues('behaviors');
    if (values.some((value) => !['keywords', 'random', 'dice', 'reactions'].includes(value)))
      throw new GuildSettingsError('invalid');
    for (const key of ['keywords', 'random', 'dice', 'reactions'] as const)
      draft.autoReply[key] = values.includes(key);
  } else if (context === 'social') {
    draft.socialPreview.videoEnabled = choice(interaction, 'video', ['on', 'off']) === 'on';
    draft.socialPreview.providers =
      capabilities.socialProviders.length > 0
        ? [...interaction.fields.getStringSelectValues('providers')]
        : [];
    if (manager || draft.socialPreview.originalMessageStrategy !== 'delete')
      draft.socialPreview.originalMessageStrategy = choice(
        interaction,
        'strategy',
        manager ? ['leave', 'suppress', 'delete'] : ['leave', 'suppress'],
      ) as GuildSettings['socialPreview']['originalMessageStrategy'];
    if (manager) {
      const maximum = numeric(interaction.fields.getTextInputValue('max_urls'));
      if (
        !Number.isInteger(maximum) ||
        maximum < 1 ||
        maximum > Math.min(5, capabilities.maxPreviewUrls)
      )
        throw new GuildSettingsError('invalid');
      draft.socialPreview.maxUrlsPerMessage = maximum;
    }
  } else if (context === 'access') {
    draft.access.mode = choice(interaction, 'audience', [
      'managers',
      'roles',
      'everyone',
    ]) as GuildSettings['access']['mode'];
    draft.access.roleIds = modalResourceValues(interaction, 'roles', ComponentType.RoleSelect);
    if (draft.access.mode === 'roles' && draft.access.roleIds.length === 0)
      throw new GuildSettingsError('invalid');
    const values = interaction.fields.getStringSelectValues('grants');
    if (values.some((value) => !(CATEGORIES as readonly string[]).includes(value)))
      throw new GuildSettingsError('invalid');
    draft.access.categories = CATEGORIES.filter((value) => values.includes(value));
  } else if (context === 'general') {
    draft.general.language = choice(interaction, 'language', [
      'inherit',
      'en',
      'zh-TW',
    ]) as GuildSettings['general']['language'];
    draft.general.timeZone = interaction.fields.getTextInputValue('time_zone').trim() || null;
  } else if (context === 'moderation') {
    draft.moderationVote.threshold = numeric(interaction.fields.getTextInputValue('threshold'));
    draft.moderationVote.voteWindowSeconds = numeric(
      interaction.fields.getTextInputValue('window'),
    );
    draft.moderationVote.durationMinutes = numeric(
      interaction.fields.getTextInputValue('duration'),
    );
    draft.moderationVote.voterRoleIds = modalResourceValues(
      interaction,
      'voter_roles',
      ComponentType.RoleSelect,
    );
  } else if (context.startsWith('entertainment_')) {
    const command = context.slice('entertainment_'.length) as EntertainmentCommand;
    draft.entertainment[command].enabled = choice(interaction, 'enabled', ['on', 'off']) === 'on';
    draft.entertainment[command].cooldownSeconds = numeric(
      interaction.fields.getTextInputValue('cooldown'),
    );
  }
};
