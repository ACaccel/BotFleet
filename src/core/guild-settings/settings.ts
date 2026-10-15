import { z } from 'zod';

export const GUILD_SETTINGS_SCHEMA_VERSION = 4;

/**
 * Older stored versions the repository upgrades on read. Version 2 added
 * defaulted sections; version 3 opens gallery previews; version 4 adds
 * opt-in earthquake destinations and removes targeted-user replies.
 */
export const UPGRADABLE_GUILD_SETTINGS_VERSIONS: readonly number[] = [1, 2, 3];

/**
 * Preview providers version 3 adds to every stored server once, so the
 * nhentai and wnacg readers start enabled everywhere; a manager who removes
 * them afterwards keeps them removed. Deployment capabilities still apply.
 */
const PROVIDERS_OPENED_IN_V3 = ['nhentai', 'wnacg'] as const;

export const FEATURES = [
  'auto_reply',
  'social_preview',
  'guild_events',
  'channel_logging',
  'activities',
  'giveaways',
  'temp_roles',
  'thread_management',
  'reports',
  'entertainment',
  'moderation_vote',
  'role_panels',
  'talk',
  'roll_call',
] as const;
export type GuildFeature = (typeof FEATURES)[number];
export const CATEGORIES = [
  'auto_reply',
  'social_preview',
  'activities',
  'giveaways',
  'temp_roles',
  'entertainment',
  'reports',
] as const;
export type GuildSettingsCategory = (typeof CATEGORIES)[number];
export const ENTERTAINMENT_COMMANDS = [
  'gay',
  'give_score',
  'random_restaurant',
  'menu_author_avatar',
  'menu_get_avatar',
  'menu_get_sticker',
  'menu_give_score',
] as const;
export type EntertainmentCommand = (typeof ENTERTAINMENT_COMMANDS)[number];
const isTimeZone = (value: string): boolean => {
  if (/^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
};
const generalSettingsSchema = z
  .object({
    language: z.enum(['inherit', 'en', 'zh-TW']),
    timeZone: z.string().min(1).max(100).refine(isTimeZone).nullable(),
  })
  .strict()
  .default({ language: 'inherit', timeZone: null });
const entertainmentCommandSchema = z
  .object({
    enabled: z.boolean(),
    cooldownSeconds: z.number().int().min(0).max(86400),
  })
  .strict()
  .default({ enabled: true, cooldownSeconds: 0 });
const entertainmentShape = Object.fromEntries(
  ENTERTAINMENT_COMMANDS.map((command) => [command, entertainmentCommandSchema]),
) as Record<EntertainmentCommand, typeof entertainmentCommandSchema>;
const entertainmentSettingsSchema = z.object(entertainmentShape).strict().default({});

const snowflake = z.string().regex(/^\d{17,20}$/);
const ids = z
  .array(snowflake)
  .max(25)
  .refine((values) => new Set(values).size === values.length);
export const featureSettingsSchema = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(['all', 'allowlist']),
    channelIds: ids,
    excludedChannelIds: ids,
  })
  .strict();
const featureShape = Object.fromEntries(
  FEATURES.map((feature) => [feature, featureSettingsSchema]),
) as Record<GuildFeature, typeof featureSettingsSchema>;
const guildSettingsAccessDraftSchema = z
  .object({
    mode: z.enum(['managers', 'roles', 'everyone']),
    roleIds: ids,
    categories: z
      .array(z.enum(CATEGORIES))
      .max(CATEGORIES.length)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict();
const guildSettingsAccessSchema = guildSettingsAccessDraftSchema.refine(
  (access) => access.mode !== 'roles' || access.roleIds.length > 0,
);
export const guildSettingsDraftSchema = z
  .object({
    general: generalSettingsSchema,
    earthquake: z
      .object({
        alertsEnabled: z.boolean(),
        reportsEnabled: z.boolean(),
        channelId: snowflake.nullable(),
        roleId: snowflake.nullable(),
      })
      .strict()
      .default({ alertsEnabled: false, reportsEnabled: false, channelId: null, roleId: null }),
    entertainment: entertainmentSettingsSchema,
    moderationVote: z
      .object({
        threshold: z.number().int().min(2).max(50),
        voteWindowSeconds: z.number().int().min(10).max(600),
        durationMinutes: z.number().int().min(1).max(5),
        voterRoleIds: ids,
      })
      .strict()
      .default({ threshold: 5, voteWindowSeconds: 60, durationMinutes: 1, voterRoleIds: [] }),
    features: z.object(featureShape).strict(),
    access: guildSettingsAccessDraftSchema,
    channels: z
      .object({
        debug: snowflake.nullable(),
        event: snowflake.nullable(),
        giveaway: snowflake.nullable(),
      })
      .strict(),
    autoReply: z
      .object({
        keywords: z.boolean(),
        random: z.boolean(),
        dice: z.boolean(),
        reactions: z.boolean(),
        probability: z.number().finite().min(0).max(1),
        cooldownSeconds: z.number().int().min(0).max(86400),
      })
      .strict(),
    socialPreview: z
      .object({
        providers: z
          .array(z.string().min(1).max(64))
          .max(25)
          .refine((values) => new Set(values).size === values.length),
        originalMessageStrategy: z.enum(['suppress', 'leave', 'delete']),
        maxUrlsPerMessage: z.number().int().min(1).max(5),
        videoEnabled: z.boolean(),
      })
      .strict(),
  })
  .strict();
export const guildSettingsSchema = guildSettingsDraftSchema.extend({
  access: guildSettingsAccessSchema,
});
export type GuildSettings = z.infer<typeof guildSettingsSchema>;
export const normalizeGuildSettings = (value: unknown): GuildSettings => {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const stored = value as Record<string, unknown>;
    if (
      stored.autoReply !== null &&
      typeof stored.autoReply === 'object' &&
      !Array.isArray(stored.autoReply)
    ) {
      // Versions 1–3 stored this retired preference; retain strict validation for other keys.
      const { lucky: _lucky, ...autoReply } = stored.autoReply as Record<string, unknown>;
      return guildSettingsSchema.parse({ ...stored, autoReply });
    }
  }
  return guildSettingsSchema.parse(value);
};

/** Bring settings stored under `fromVersion` to the current schema version. */
export const upgradeGuildSettings = (fromVersion: number, value: unknown): GuildSettings => {
  const settings = normalizeGuildSettings(value);
  if (fromVersion >= 3) return settings;
  const providers = settings.socialPreview.providers;
  return normalizeGuildSettings({
    ...settings,
    socialPreview: {
      ...settings.socialPreview,
      providers: [
        ...providers,
        ...PROVIDERS_OPENED_IN_V3.filter((provider) => !providers.includes(provider)),
      ],
    },
  });
};
export interface GuildSettingsAudit {
  readonly operationId: string;
  readonly revision: number;
  readonly userId: string;
  readonly at: number;
  readonly paths: readonly string[];
}
export interface GuildSettingsSnapshot {
  readonly schemaVersion?: number;
  readonly updatedAt?: number;
  readonly updatedBy?: string | null;
  readonly botId: string;
  readonly guildId: string;
  readonly revision: number;
  readonly settings: GuildSettings;
  readonly audit: readonly GuildSettingsAudit[];
  readonly lastOperationId: string;
}
export interface GuildSettingsActor {
  readonly botId: string;
  readonly guildId: string;
  readonly userId: string;
  readonly manager: boolean;
  readonly roleIds: readonly string[];
  readonly messageId?: string;
}
export interface OperatorCapabilities {
  readonly earthquake?: {
    readonly alerts: boolean;
    readonly reports: boolean;
  };
  readonly features: Readonly<Record<GuildFeature, boolean>>;
  readonly socialProviders: readonly string[];
  readonly maxRandomProbability: number;
  readonly minCooldownSeconds: number;
  readonly maxPreviewUrls: number;
}
export interface GuildSettingsRuntime {
  get(guildId: string): GuildSettingsSnapshot | undefined;
  isEnabled(
    guildId: string,
    feature: GuildFeature,
    channelId?: string,
    ancestors?: readonly string[],
  ): boolean;
}
export type GuildSettingsErrorCode =
  | 'forbidden'
  | 'expired'
  | 'invalid'
  | 'conflict'
  | 'unavailable'
  | 'pending';
export class GuildSettingsError extends Error {
  constructor(
    public readonly code: GuildSettingsErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'GuildSettingsError';
  }
}
export const defaultGuildSettings = (capabilities: OperatorCapabilities): GuildSettings => ({
  general: guildSettingsSchema.shape.general.parse(undefined),
  earthquake: guildSettingsSchema.shape.earthquake.parse(undefined),
  entertainment: entertainmentSettingsSchema.parse(undefined),
  moderationVote: guildSettingsSchema.shape.moderationVote.parse(undefined),
  features: guildSettingsSchema.shape.features.parse(
    Object.fromEntries(
      FEATURES.map((feature) => [
        feature,
        {
          enabled:
            capabilities.features[feature] &&
            ![
              'auto_reply',
              'social_preview',
              'guild_events',
              'channel_logging',
              'moderation_vote',
            ].includes(feature),
          mode: 'all',
          channelIds: [],
          excludedChannelIds: [],
        },
      ]),
    ),
  ),
  access: { mode: 'managers', roleIds: [], categories: [] },
  channels: { debug: null, event: null, giveaway: null },
  autoReply: {
    keywords: true,
    random: true,
    dice: true,
    reactions: true,
    probability: Math.min(0.005, capabilities.maxRandomProbability),
    cooldownSeconds: Math.max(5, capabilities.minCooldownSeconds),
  },
  socialPreview: {
    providers: [...capabilities.socialProviders],
    originalMessageStrategy: 'suppress',
    maxUrlsPerMessage: Math.min(1, capabilities.maxPreviewUrls),
    videoEnabled: true,
  },
});

export const cloneSettings = (settings: GuildSettings): GuildSettings => structuredClone(settings);
export const immutableSnapshot = (snapshot: GuildSettingsSnapshot): GuildSettingsSnapshot => {
  const freeze = (value: unknown): void => {
    if (value !== null && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  };
  const copy = structuredClone(snapshot);
  freeze(copy);
  return copy;
};
export const changedSettingsPaths = (before: GuildSettings, after: GuildSettings): string[] => {
  const paths: string[] = [];
  const compare = (left: unknown, right: unknown, path: string): void => {
    if (JSON.stringify(left) === JSON.stringify(right)) return;
    if (
      left !== null &&
      right !== null &&
      typeof left === 'object' &&
      typeof right === 'object' &&
      !Array.isArray(left) &&
      !Array.isArray(right)
    ) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        compare(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
          path ? `${path}.${key}` : key,
        );
      }
    } else paths.push(path);
  };
  compare(before, after, '');
  return paths;
};
