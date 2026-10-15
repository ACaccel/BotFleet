import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type MessageEditOptions,
} from 'discord.js';
import {
  ENTERTAINMENT_COMMANDS,
  FEATURES,
  changedSettingsPaths,
  type EntertainmentCommand,
  type GuildFeature,
  type GuildSettingsActor,
  type OperatorCapabilities,
} from '../../core/guild-settings';
import type { Translator } from '../../core/i18n';
import type { GuildSettingsSession } from './session';
import { categoryForPath } from './authority';
import { panelId } from './panel-id';
import { boundedPanelLines, settingsFieldLabel, summarizeSettingsList } from './panel-diff';
export type PanelCategory =
  | 'access'
  | 'general'
  | 'features'
  | 'channels'
  | 'auto_reply'
  | 'social'
  | 'entertainment'
  | 'moderation'
  | 'status'
  | 'history';
export type PanelTranslate = (key: string, params?: Record<string, string | number>) => string;
export const panelTranslate =
  (translator: Translator | undefined, locale: string): PanelTranslate =>
  (key, params) =>
    translator?.t(
      `replies:settings.${key}`,
      params,
      locale === 'en-US' || locale === 'en-GB' || locale === 'en' ? 'en' : 'zh-TW',
    ) ?? key;
export const canEditPanelPath = (
  actor: GuildSettingsActor,
  committed: GuildSettingsSession['base'],
  path: string,
): boolean => {
  const category = categoryForPath(path);
  return (
    actor.manager || (category !== undefined && committed.access.categories.includes(category))
  );
};
export const panelCategories = (
  actor: GuildSettingsActor,
  session: GuildSettingsSession,
  committed = session.base,
): PanelCategory[] => {
  const categories: PanelCategory[] = actor.manager
    ? ['general', 'access', 'features', 'channels', 'moderation']
    : ['features'];
  if (canEditPanelPath(actor, committed, 'autoReply.probability')) categories.push('auto_reply');
  if (canEditPanelPath(actor, committed, 'socialPreview.videoEnabled')) categories.push('social');
  if (canEditPanelPath(actor, committed, 'entertainment.gay.enabled'))
    categories.push('entertainment');
  categories.push('status', 'history');
  return categories;
};
const button = (
  session: GuildSettingsSession,
  action: string,
  label: string,
  detail = '',
  disabled = false,
): ButtonBuilder =>
  new ButtonBuilder()
    .setCustomId(panelId(session.id, action, detail))
    .setLabel(label)
    .setStyle(action === 'save' ? ButtonStyle.Primary : ButtonStyle.Secondary)
    .setDisabled(disabled);
export const renderSettingsPanel = (
  session: GuildSettingsSession,
  actor: GuildSettingsActor,
  capabilities: OperatorCapabilities,
  t: PanelTranslate,
  category: PanelCategory = 'features',
  feature?: GuildFeature,
  _destination: 'debug' | 'event' | 'giveaway' = 'debug',
  notice?: string,
  history: readonly { revision: number; userId: string; paths: readonly string[] }[] = [],
  visibleChannelIds?: ReadonlySet<string>,
  committed = session.base,
  availableRoleIds?: ReadonlySet<string>,
  entertainmentCommand: EntertainmentCommand = 'gay',
): MessageEditOptions => {
  if (!panelCategories(actor, session, committed).includes(category)) category = 'features';
  const editableFeatures = FEATURES.filter((value) =>
    canEditPanelPath(actor, committed, `features.${value}.enabled`),
  );
  const currentFeature =
    feature && editableFeatures.includes(feature) ? feature : editableFeatures[0];
  const changes = changedSettingsPaths(session.base, session.draft).filter((path) =>
    canEditPanelPath(actor, committed, path),
  );
  const embed = new EmbedBuilder()
    .setTitle(t('title'))
    .setDescription(
      [t('shared'), t('summary', { revision: session.baseRevision, count: changes.length }), notice]
        .filter(Boolean)
        .join('\n'),
    )
    .setFooter({ text: t(`category.${category}`) });
  const components: NonNullable<MessageEditOptions['components']>[number][] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(panelId(session.id, 'category'))
        .setPlaceholder(t('category_placeholder'))
        .addOptions(
          panelCategories(actor, session, committed).map((value) => ({
            label: t(`category.${value}`),
            value,
            default: value === category,
          })),
        ),
    ),
  ];
  const edit = (context: string): void => {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(session, 'edit', t('button.edit'), context),
      ),
    );
  };
  if (category === 'access') {
    embed.addFields(
      { name: t('audience'), value: t(`mode.${session.draft.access.mode}`) },
      {
        name: t('roles'),
        value: summarizeSettingsList(
          session.draft.access.roleIds.map((id) =>
            (availableRoleIds?.has(id) ?? true) ? `<@&${id}>` : t('hidden_resource'),
          ),
          t,
        ),
      },
      {
        name: t('grants'),
        value: summarizeSettingsList(
          session.draft.access.categories.map((value) => t(`grant.${value}`)),
          t,
        ),
      },
    );
    if (session.draft.access.mode === 'everyone')
      embed.addFields({ name: t('mode.everyone'), value: t('access_warning') });
    edit('access');
  } else if (category === 'general') {
    embed.addFields(
      { name: t('parameter.language'), value: t(`language.${session.draft.general.language}`) },
      {
        name: t('parameter.timeZone'),
        value: session.draft.general.timeZone ?? t('language.inherit'),
      },
    );
    edit('general');
  } else if (category === 'features' && currentFeature) {
    const settings = session.draft.features[currentFeature];
    embed.addFields({
      name: t(`feature.${currentFeature}`),
      value: [
        t(settings.enabled ? 'enabled' : 'disabled'),
        !capabilities.features[currentFeature] ? t('unavailable_feature') : '',
        t('scope_description', {
          scope: t(settings.mode),
          allowed: settings.channelIds.length,
          excluded: settings.excludedChannelIds.length,
        }),
        t('scope_note'),
        t('lifecycle'),
      ]
        .filter(Boolean)
        .join('\n'),
    });
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(panelId(session.id, 'feature'))
          .setPlaceholder(t('feature_placeholder'))
          .addOptions(
            editableFeatures.map((value) => ({
              label: t(`feature.${value}`),
              value,
              default: value === currentFeature,
            })),
          ),
      ),
    );
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(
          session,
          'toggle',
          t('button.toggle'),
          currentFeature,
          !capabilities.features[currentFeature],
        ),
        button(session, 'edit', t('button.scope'), `scope_${currentFeature}`),
      ),
    );
  } else if (category === 'channels') {
    for (const destination of ['debug', 'event', 'giveaway'] as const) {
      const id = session.draft.channels[destination];
      embed.addFields({
        name: t(`destination.${destination}`),
        value: !id
          ? t('not_set')
          : (visibleChannelIds?.has(id) ?? true)
            ? `<#${id}>`
            : t('hidden_resource'),
      });
    }
    edit('channels');
  } else if (category === 'entertainment') {
    const setting = session.draft.entertainment[entertainmentCommand];
    embed.addFields({
      name: t(`entertainment_command.${entertainmentCommand}`),
      value: `${t(setting.enabled ? 'enabled' : 'disabled')}\n${t('cooldown')}: ${setting.cooldownSeconds}`,
    });
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(panelId(session.id, 'entertainment'))
          .setPlaceholder(t('entertainment_placeholder'))
          .addOptions(
            ENTERTAINMENT_COMMANDS.map((value) => ({
              label: t(`entertainment_command.${value}`),
              value,
              default: value === entertainmentCommand,
            })),
          ),
      ),
    );
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(session, 'entertainment_toggle', t('button.toggle'), entertainmentCommand),
        button(session, 'edit', t('button.edit'), `entertainment_${entertainmentCommand}`),
      ),
    );
  } else if (category === 'moderation') {
    const setting = session.draft.moderationVote;
    embed.addFields(
      ...(['threshold', 'voteWindowSeconds', 'durationMinutes'] as const).map((key) => ({
        name: t(`parameter.${key}`),
        value: String(setting[key]),
      })),
      {
        name: t('parameter.voterRoleIds'),
        value: setting.voterRoleIds.length
          ? summarizeSettingsList(
              setting.voterRoleIds.map((id) =>
                (availableRoleIds?.has(id) ?? true) ? `<@&${id}>` : t('hidden_resource'),
              ),
              t,
            )
          : t('mode.everyone'),
      },
    );
    edit('moderation');
  } else if (category === 'auto_reply' || category === 'social') {
    const fields =
      category === 'auto_reply' ? session.draft.autoReply : session.draft.socialPreview;
    const summary = Object.entries(fields)
      .filter(
        ([key]) =>
          actor.manager ||
          (key !== 'maxUrlsPerMessage' &&
            (key !== 'originalMessageStrategy' ||
              session.draft.socialPreview.originalMessageStrategy !== 'delete')),
      )
      .map(
        ([key, value]) =>
          `${t(`parameter.${key}`)}: ${typeof value === 'boolean' ? t(value ? 'enabled' : 'disabled') : Array.isArray(value) ? value.map((provider: string) => t(`provider.${provider}`)).join(', ') || t('not_set') : key === 'probability' ? `${Number(value) * 100}%` : typeof value === 'string' ? t(`strategies.${value}`) : value}`,
      )
      .join('\n');
    embed.addFields({ name: t(`category.${category}`), value: summary });
    edit(category);
  } else if (category === 'status') {
    embed.addFields(
      { name: t('category.status'), value: t('status_description') },
      { name: t('revision', { revision: session.baseRevision }), value: t('storage_notice') },
    );
  } else if (category === 'history') {
    const entries = history
      .map((entry) => ({
        ...entry,
        paths: entry.paths.filter((path) => canEditPanelPath(actor, committed, path)),
      }))
      .filter((entry) => entry.paths.length > 0)
      .slice(-8)
      .reverse();
    embed.addFields({
      name: t('category.history'),
      value:
        boundedPanelLines(
          entries.map((entry) =>
            t('history_entry', {
              revision: entry.revision,
              actor: entry.userId,
              fields: summarizeSettingsList(
                entry.paths.map((path) => settingsFieldLabel(path, t)),
                t,
              ),
            }),
          ),
          t,
          1024,
          'more_items',
        ) || t('empty_history'),
    });
  }
  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      button(session, 'preview', t('button.preview'), category),
      button(session, 'save', t('button.save'), category, session.pending || changes.length === 0),
      button(
        session,
        'discard',
        t('button.discard'),
        category,
        session.pending || changes.length === 0,
      ),
      button(session, 'reload', t('button.reload'), category, session.pending),
    ),
  );
  return { content: '', embeds: [embed], components, allowedMentions: { parse: [] } };
};
