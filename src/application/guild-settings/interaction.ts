import {
  ChannelType,
  ComponentType,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type RoleSelectMenuInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import {
  FEATURES,
  ENTERTAINMENT_COMMANDS,
  cloneSettings,
  changedSettingsPaths,
  GuildSettingsError,
  type GuildFeature,
  type EntertainmentCommand,
  type GuildSettingsActor,
} from '../../core/guild-settings';
import type { Translator } from '../../core/i18n';
import { logError, type Logger } from '../../core/logger';
import { replyForError } from '../../infra/discord/reply-for-error';
import type { GuildSettingsService } from './service';
import { parsePanelId } from './panel-id';
import { previewSettingsChanges } from './panel-diff';
import {
  buildPanelModal,
  applyPanelModal,
  parseModalContext,
  modalResourceValues,
  DESTINATION_CHANNEL_TYPES,
  SCOPE_CHANNEL_TYPES,
  type PanelModalContext,
} from './panel-modal';
import {
  renderSettingsPanel,
  panelTranslate,
  canEditPanelPath,
  panelCategories,
  type PanelCategory,
} from './panel-view';

export interface SettingsPanelHost {
  readonly guildSettings: GuildSettingsService | undefined;
  readonly translator: Translator | undefined;
  readonly logger: Logger | undefined;
}
export type SettingsSelectInteraction =
  | StringSelectMenuInteraction
  | RoleSelectMenuInteraction
  | ChannelSelectMenuInteraction;
type ComponentInteraction = ButtonInteraction | SettingsSelectInteraction | ModalSubmitInteraction;
type SettingsInteraction = ComponentInteraction | ChatInputCommandInteraction;
const actorFor = async (
  interaction: SettingsInteraction,
  fetchMember: boolean,
): Promise<GuildSettingsActor> => {
  if (!interaction.guild || !interaction.guildId || !interaction.member)
    throw new GuildSettingsError('forbidden');
  const member = fetchMember
    ? await interaction.guild.members.fetch({ user: interaction.user.id, force: true })
    : interaction.member;
  const roleIds = member instanceof GuildMember ? [...member.roles.cache.keys()] : member.roles;
  const manager =
    interaction.guild.ownerId === interaction.user.id ||
    (member instanceof GuildMember
      ? member.permissions.has(PermissionFlagsBits.ManageGuild)
      : interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) === true);
  const messageId = 'message' in interaction ? interaction.message?.id : undefined;
  return {
    botId: interaction.applicationId,
    guildId: interaction.guildId,
    userId: interaction.user.id,
    manager,
    roleIds,
    ...(messageId === undefined ? {} : { messageId }),
  };
};
const serviceFor = (host: SettingsPanelHost): GuildSettingsService => {
  if (!host.guildSettings) throw new GuildSettingsError('unavailable');
  return host.guildSettings;
};
const reportError = async (
  interaction: SettingsInteraction,
  host: SettingsPanelHost,
  error: unknown,
): Promise<void> => {
  if (!(error instanceof GuildSettingsError)) {
    await replyForError(interaction, host, error, 'errors:settings.failed', interaction.guildId);
    return;
  }
  logError(host.logger, interaction.guildId, error);
  const content =
    host.translator?.t(
      `errors:settings.${error.code}`,
      undefined,
      interaction.locale.startsWith('en') ? 'en' : 'zh-TW',
    ) ?? error.code;
  if (interaction.deferred || interaction.replied)
    await interaction.followUp({
      content,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  else
    await interaction.reply({
      content,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
};
const featureFrom = (value: string | undefined): GuildFeature => {
  const feature = FEATURES.find((candidate) => candidate === value);
  if (!feature) throw new GuildSettingsError('invalid');
  return feature;
};
const channelIds = async (
  interaction: ComponentInteraction,
  values: readonly string[],
  destination: boolean,
): Promise<string[]> => {
  if (!interaction.guild || !/^\d{17,20}$/.test(interaction.user.id))
    throw new GuildSettingsError('invalid');
  const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
  const allowed = new Set<ChannelType>(
    destination ? DESTINATION_CHANNEL_TYPES : SCOPE_CHANNEL_TYPES,
  );
  if (values.length > (destination ? 1 : 25)) throw new GuildSettingsError('invalid');
  for (const id of values) {
    if (!/^\d{17,20}$/.test(id)) throw new GuildSettingsError('invalid');
    const channel = await interaction.guild.channels.fetch(id);
    if (
      !channel ||
      channel.guildId !== interaction.guildId ||
      !allowed.has(channel.type) ||
      !channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)
    )
      throw new GuildSettingsError('invalid');
  }
  return [...values];
};
const visibleChannels = (interaction: SettingsInteraction): ReadonlySet<string> => {
  if (!interaction.guild || !interaction.member) return new Set();
  return new Set(
    interaction.guild.channels.cache
      .filter(
        (channel) =>
          channel.permissionsFor(interaction.user.id)?.has(PermissionFlagsBits.ViewChannel) ===
          true,
      )
      .keys(),
  );
};
const resourceStatus = (
  interaction: SettingsInteraction,
  host: SettingsPanelHost,
  actor: GuildSettingsActor,
): string | undefined => {
  if (!actor.manager || !interaction.guild) return undefined;
  const snapshot = host.guildSettings?.get(actor.guildId);
  const member = interaction.guild.members.me;
  if (!snapshot) return undefined;
  const t = panelTranslate(host.translator, interaction.locale);
  const destinations = Object.entries(snapshot.settings.channels);
  const earthquake = snapshot.settings.earthquake;
  if ((earthquake.alertsEnabled || earthquake.reportsEnabled) && earthquake.channelId)
    destinations.push(['earthquake', earthquake.channelId]);
  return (
    destinations
      .filter(([, id]) => id !== null)
      .map(([name, id]) => {
        const channel = id ? interaction.guild?.channels.cache.get(id) : undefined;
        const valid =
          channel &&
          !channel.isThread() &&
          (channel.type === ChannelType.GuildText ||
            channel.type === ChannelType.GuildAnnouncement) &&
          member &&
          channel
            .permissionsFor(member)
            ?.has([
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.EmbedLinks,
            ]);
        return valid
          ? ''
          : t('destination_unavailable', {
              destination: t(
                name === 'earthquake' ? 'parameter.earthquakeChannelId' : `destination.${name}`,
              ),
            });
      })
      .filter(Boolean)
      .join('\n') || undefined
  );
};
export const openSettingsPanel = async (
  interaction: ChatInputCommandInteraction,
  host: SettingsPanelHost,
): Promise<void> => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (!interaction.guildId) {
      await interaction.editReply({
        content: host.translator?.t('errors:settings.guild_only') ?? '',
      });
      return;
    }
    const service = serviceFor(host);
    const actor = await actorFor(interaction, true);
    const session = await service.open(actor);
    await interaction.editReply(
      renderSettingsPanel(
        session,
        actor,
        service.capabilities,
        panelTranslate(host.translator, interaction.locale),
        'features',
        undefined,
        'debug',
        undefined,
        [],
        visibleChannels(interaction),
        service.get(actor.guildId)?.settings,
        new Set(interaction.guild?.roles.cache.keys() ?? []),
      ),
    );
    const message = await interaction.fetchReply();
    await service.bindMessage(session.id, actor, message.id);
  } catch (error) {
    await reportError(interaction, host, error);
  }
};
const categoryForContext = (context: PanelModalContext): PanelCategory =>
  context.startsWith('scope_')
    ? 'features'
    : context.startsWith('entertainment_')
      ? 'entertainment'
      : (context as PanelCategory);
const pathForContext = (context: PanelModalContext): string =>
  context.startsWith('scope_')
    ? `features.${context.slice(6)}.mode`
    : context.startsWith('entertainment_')
      ? `entertainment.${context.slice(14)}.enabled`
      : ((
          {
            access: 'access.mode',
            channels: 'channels.debug',
            general: 'general.language',
            auto_reply: 'autoReply.probability',
            social: 'socialPreview.videoEnabled',
            moderation: 'moderationVote.threshold',
            earthquake: 'earthquake.alertsEnabled',
          } as Record<string, string>
        )[context] ?? '');
const separateAccess = (
  session: Awaited<ReturnType<GuildSettingsService['getSession']>>,
  context: PanelModalContext,
): boolean =>
  changedSettingsPaths(session.base, session.draft).some((path) =>
    context === 'access' ? !path.startsWith('access.') : path.startsWith('access.'),
  );
const validateRoles = async (
  interaction: ComponentInteraction,
  ids: readonly string[],
  editorRoles: boolean,
): Promise<void> => {
  if (!interaction.guild || ids.length > 25 || new Set(ids).size !== ids.length)
    throw new GuildSettingsError('invalid');
  for (const id of ids) {
    const role = /^\d{17,20}$/.test(id) ? await interaction.guild.roles.fetch(id) : null;
    if (
      !role ||
      role.guild.id !== interaction.guildId ||
      role.id === interaction.guildId ||
      (editorRoles && role.managed)
    )
      throw new GuildSettingsError('invalid');
  }
};
export const handleSettingsInteraction = async (
  interaction: ComponentInteraction,
  host: SettingsPanelHost,
): Promise<void> => {
  const id = parsePanelId(interaction.customId);
  try {
    if (!id) throw new GuildSettingsError('invalid');
    const service = serviceFor(host);
    const isModalOpen = interaction.isButton() && id.action === 'edit';
    if (!isModalOpen) await interaction.deferUpdate();
    const actor = await actorFor(interaction, !isModalOpen);
    const t = panelTranslate(host.translator, interaction.locale);
    let category: PanelCategory = 'features';
    let feature: GuildFeature | undefined;
    let entertainmentCommand: EntertainmentCommand = 'gay';
    let notice: string | undefined;
    if (isModalOpen) {
      const context = parseModalContext(id.detail);
      if (!context) throw new GuildSettingsError('invalid');
      const { session, nonce } = service.beginModal(id.sessionId, actor, context);
      if (
        !canEditPanelPath(
          actor,
          service.get(actor.guildId)?.settings ?? session.base,
          pathForContext(context),
        )
      )
        throw new GuildSettingsError('forbidden');
      if (separateAccess(session, context)) {
        await interaction.reply({ content: t('access_separate'), flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.showModal(
        buildPanelModal(session, context, nonce, actor.manager, service.capabilities, t, {
          visibleChannelIds: visibleChannels(interaction),
          availableRoleIds: new Set(interaction.guild?.roles.cache.keys() ?? []),
        }),
      );
      return;
    }
    let session = await service.getSession(id.sessionId, actor);
    const draft = cloneSettings(session.draft);
    if (['save', 'discard', 'reload', 'preview'].includes(id.action) && interaction.isButton()) {
      category =
        panelCategories(
          actor,
          session,
          service.get(actor.guildId)?.settings,
          service.capabilities,
        ).find((value) => value === id.detail) ?? 'features';
      if (id.action === 'save') {
        await service.save(session.id, actor);
        session = await service.getSession(session.id, actor);
        notice = t('saved');
      } else if (id.action === 'discard' || id.action === 'reload') {
        session = await service.discard(session.id, actor);
        notice = t('discarded');
      } else
        notice = previewSettingsChanges(
          session.base,
          session.draft,
          changedSettingsPaths(session.base, session.draft).filter((path) =>
            canEditPanelPath(actor, service.get(actor.guildId)?.settings ?? session.base, path),
          ),
          t,
          {
            visibleChannelIds: visibleChannels(interaction),
            availableRoleIds: new Set(interaction.guild?.roles.cache.keys() ?? []),
            manager: actor.manager,
          },
        );
    } else if (interaction.isStringSelectMenu() && id.action === 'category') {
      const selected = panelCategories(
        actor,
        session,
        service.get(actor.guildId)?.settings,
        service.capabilities,
      ).find((value) => value === interaction.values[0]);
      if (!selected) throw new GuildSettingsError('forbidden');
      if (selected === 'access' && separateAccess(session, 'access')) notice = t('access_separate');
      else if (
        selected !== 'access' &&
        changedSettingsPaths(session.base, session.draft).some((path) => path.startsWith('access.'))
      ) {
        category = 'access';
        notice = t('access_separate');
      } else category = selected;
    } else if (interaction.isStringSelectMenu() && id.action === 'feature')
      feature = featureFrom(interaction.values[0]);
    else if (interaction.isStringSelectMenu() && id.action === 'entertainment') {
      const command = ENTERTAINMENT_COMMANDS.find((value) => value === interaction.values[0]);
      if (!command) throw new GuildSettingsError('invalid');
      if (
        !canEditPanelPath(
          actor,
          service.get(actor.guildId)?.settings ?? session.base,
          `entertainment.${command}.enabled`,
        )
      )
        throw new GuildSettingsError('forbidden');
      category = 'entertainment';
      entertainmentCommand = command;
    } else if (interaction.isButton() && id.action === 'toggle') {
      feature = featureFrom(id.detail);
      draft.features[feature].enabled = !draft.features[feature].enabled;
      await service.stage(session.id, actor, draft);
    } else if (interaction.isButton() && id.action === 'entertainment_toggle') {
      const command = ENTERTAINMENT_COMMANDS.find((value) => value === id.detail);
      if (!command) throw new GuildSettingsError('invalid');
      category = 'entertainment';
      entertainmentCommand = command;
      draft.entertainment[command].enabled = !draft.entertainment[command].enabled;
      await service.stage(session.id, actor, draft);
    } else if (interaction.isModalSubmit() && id.action === 'modal' && id.nonce) {
      const context = parseModalContext(id.detail);
      if (!context) throw new GuildSettingsError('invalid');
      session = await service.consumeModalNonce(session.id, actor, id.nonce, context);
      if (
        !canEditPanelPath(
          actor,
          service.get(actor.guildId)?.settings ?? session.base,
          pathForContext(context),
        )
      )
        throw new GuildSettingsError('forbidden');
      if (separateAccess(session, context)) throw new GuildSettingsError('invalid');
      category = categoryForContext(context);
      applyPanelModal(draft, interaction, context, actor.manager, service.capabilities);
      if (context.startsWith('scope_')) {
        feature = featureFrom(context.slice(6));
        const mode = interaction.fields.getStringSelectValues('mode');
        if (mode.length !== 1 || (mode[0] !== 'all' && mode[0] !== 'allowlist'))
          throw new GuildSettingsError('invalid');
        const scope = draft.features[feature];
        scope.mode = mode[0];
        const visible = visibleChannels(interaction);
        for (const [field, key] of [
          ['allowed', 'channelIds'],
          ['excluded', 'excludedChannelIds'],
        ] as const) {
          const selected = await channelIds(
            interaction,
            modalResourceValues(interaction, field, ComponentType.ChannelSelect),
            false,
          );
          const retained = actor.manager ? [] : scope[key].filter((value) => !visible.has(value));
          scope[key] = [...new Set([...retained, ...selected])];
        }
      } else if (context === 'channels') {
        for (const destination of ['debug', 'event', 'giveaway'] as const)
          draft.channels[destination] =
            (
              await channelIds(
                interaction,
                modalResourceValues(interaction, destination, ComponentType.ChannelSelect),
                true,
              )
            )[0] ?? null;
      } else if (context === 'earthquake') {
        draft.earthquake.channelId =
          (
            await channelIds(
              interaction,
              draft.earthquake.channelId ? [draft.earthquake.channelId] : [],
              true,
            )
          )[0] ?? null;
        await validateRoles(
          interaction,
          draft.earthquake.roleId ? [draft.earthquake.roleId] : [],
          false,
        );
      } else if (context === 'access') await validateRoles(interaction, draft.access.roleIds, true);
      else if (context === 'moderation')
        await validateRoles(interaction, draft.moderationVote.voterRoleIds, false);
      else if (context.startsWith('entertainment_'))
        entertainmentCommand = context.slice(14) as EntertainmentCommand;
      await service.stage(session.id, actor, draft);
    } else throw new GuildSettingsError('invalid');
    session = await service.getSession(session.id, actor);
    if (category === 'status') notice = resourceStatus(interaction, host, actor);
    await interaction.editReply(
      renderSettingsPanel(
        session,
        actor,
        service.capabilities,
        t,
        category,
        feature,
        'debug',
        notice,
        service.get(actor.guildId)?.audit,
        visibleChannels(interaction),
        service.get(actor.guildId)?.settings,
        new Set(interaction.guild?.roles.cache.keys() ?? []),
        entertainmentCommand,
      ),
    );
  } catch (error) {
    await reportError(interaction, host, error);
  }
};
