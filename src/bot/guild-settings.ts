import { PermissionFlagsBits, ChannelType, type Guild, type GuildMember } from 'discord.js';
import { z } from 'zod';
import type { BaseBot, Config } from './index';
import { TOKENS } from './tokens';
import { asGuildId } from '../core/ids';
import {
  changedSettingsPaths,
  defaultGuildSettings,
  FEATURES,
  ENTERTAINMENT_COMMANDS,
  GuildSettingsError,
  type GuildSettings,
  type GuildSettingsActor,
  type OperatorCapabilities,
} from '../core/guild-settings';
import { GuildSettingsService } from '../application/guild-settings/service';
import { assertSettingsAuthority } from '../application/guild-settings/authority';
import { parseAutoReplyConfig } from '../plugins/auto-reply/config';
import { parseSocialLinkPreviewConfig } from '../plugins/social-link-preview/config';
import { LINK_PREVIEW_PROVIDER_NAMES } from '../infra/link-preview';

interface SettingsConfig extends Config {
  auto_reply?: unknown;
  social_link_preview?: unknown;
  guild_settings?: unknown;
}

const operatorSchema = z
  .object({
    maxRandomProbability: z.number().finite().min(0).max(1).default(1),
    minCooldownSeconds: z.number().int().min(0).max(86400).default(0),
  })
  .strict();

const currentMember = async (guild: Guild, userId: string): Promise<GuildMember> => {
  try {
    return await guild.members.fetch({ user: userId, force: true });
  } catch (error: unknown) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 10007)
      throw new GuildSettingsError('forbidden');
    throw error;
  }
};

/** The guild panel can tighten availability, never load a missing plugin. */
const capabilitiesOf = (config: SettingsConfig): OperatorCapabilities => {
  const limits = operatorSchema.parse(config.guild_settings ?? {});
  const social = parseSocialLinkPreviewConfig(config.social_link_preview);
  const commands = new Set(config.commands ?? []);
  const features = Object.fromEntries(FEATURES.map((feature) => [feature, false])) as Record<
    (typeof FEATURES)[number],
    boolean
  >;
  Object.assign(features, {
    auto_reply: true,
    social_preview: social.enabled,
    guild_events: true,
    channel_logging: true,
    activities: commands.has('activity'),
    giveaways: commands.has('giveaway'),
    temp_roles: commands.has('role'),
    role_panels: commands.has('role'),
    thread_management: commands.has('thread'),
    reports: commands.has('traffic') || commands.has('level_detail'),
    entertainment: ENTERTAINMENT_COMMANDS.some((name) => commands.has(name)),
    moderation_vote: commands.has('ban_user'),
    talk: commands.has('talk'),
    roll_call: commands.has('roll_call') || commands.has('activity'),
  });
  return {
    features,
    socialProviders: social.providers ?? LINK_PREVIEW_PROVIDER_NAMES,
    maxPreviewUrls: social.maxUrlsPerMessage,
    ...limits,
  };
};

const validateResources = async (
  bot: BaseBot,
  settings: GuildSettings,
  actor: GuildSettingsActor,
  committed: GuildSettings,
): Promise<void> => {
  const guild = bot.client.guilds.cache.get(actor.guildId);
  if (!guild) throw new GuildSettingsError('forbidden');
  const paths = new Set(changedSettingsPaths(committed, settings));
  const member = await currentMember(guild, actor.userId);
  assertSettingsAuthority(
    {
      ...actor,
      manager:
        guild.ownerId === actor.userId || member.permissions.has(PermissionFlagsBits.ManageGuild),
      roleIds: [...member.roles.cache.keys()],
    },
    committed,
    [...paths],
    settings,
  );
  const botMember = guild.members.me ?? (await guild.members.fetchMe());
  const channels = new Set<string>();
  for (const feature of FEATURES) {
    for (const key of ['channelIds', 'excludedChannelIds'] as const) {
      if (paths.has(`features.${feature}.${key}`))
        settings.features[feature][key].forEach((id) => channels.add(id));
    }
  }
  for (const slot of ['debug', 'event', 'giveaway'] as const) {
    const id = settings.channels[slot];
    if (!paths.has(`channels.${slot}`) || id === null) continue;
    channels.add(id);
    const channel = await guild.channels.fetch(id, { force: true });
    if (
      !channel ||
      channel.guildId !== guild.id ||
      ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) ||
      !channel
        .permissionsFor(botMember)
        ?.has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
        ])
    )
      throw new GuildSettingsError('invalid', 'Destination is unavailable');
  }
  for (const id of channels) {
    const channel = await guild.channels.fetch(id, { force: true });
    if (
      !channel ||
      channel.guildId !== guild.id ||
      !channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)
    )
      throw new GuildSettingsError('invalid', 'Channel is unavailable');
  }
  for (const [path, roleIds] of [
    ['access.roleIds', settings.access.roleIds],
    ['moderationVote.voterRoleIds', settings.moderationVote.voterRoleIds],
  ] as const) {
    if (!paths.has(path)) continue;
    for (const id of roleIds) {
      const role = await guild.roles.fetch(id, { force: true });
      if (!role || role.guild.id !== guild.id || id === guild.id)
        throw new GuildSettingsError('invalid', 'Editor role is unavailable');
    }
  }
};

export const createGuildSettings = (bot: BaseBot, config: SettingsConfig): GuildSettingsService => {
  const capabilities = capabilitiesOf(config);
  const auto = parseAutoReplyConfig(config.auto_reply);
  const social = parseSocialLinkPreviewConfig(config.social_link_preview);
  return new GuildSettingsService({
    botId: bot.clientId,
    capabilities,
    resolveActor: async (identity) => {
      const guild = bot.client.guilds.cache.get(identity.guildId);
      if (!guild) throw new GuildSettingsError('forbidden');
      const member = await currentMember(guild, identity.userId);
      return {
        ...identity,
        manager:
          guild.ownerId === identity.userId ||
          member.permissions.has(PermissionFlagsBits.ManageGuild),
        roleIds: [...member.roles.cache.keys()],
      };
    },
    repo: (guildId) => {
      const repo = bot.getRepos(guildId)?.guildSettings;
      if (!repo) throw new GuildSettingsError('unavailable');
      return repo;
    },
    migrationRepo: async () =>
      (await bot.container.resolve(TOKENS.ReposFactory)(asGuildId(bot.clientId))).guildSettings,
    legacySeed: (guildId) => {
      const settings = defaultGuildSettings(capabilities);
      for (const feature of FEATURES)
        settings.features[feature].enabled = capabilities.features[feature];
      const maps = config.guilds?.[guildId]?.channels;
      settings.channels = {
        debug: maps?.debug ?? null,
        event: maps?.event ?? null,
        giveaway: maps?.giveaway ?? null,
      };
      settings.autoReply.probability = Math.min(
        auto.globalLuckyProbability,
        capabilities.maxRandomProbability,
      );
      settings.autoReply.cooldownSeconds = capabilities.minCooldownSeconds;
      settings.socialPreview.originalMessageStrategy = social.originalMessageStrategy;
      settings.socialPreview.maxUrlsPerMessage = social.maxUrlsPerMessage;
      return settings;
    },
    validateResources: (settings, actor, committed) =>
      validateResources(bot, settings, actor, committed),
  });
};
