import { Schema } from 'mongoose';
import {
  CATEGORIES,
  GUILD_SETTINGS_SCHEMA_VERSION,
  ENTERTAINMENT_COMMANDS,
  FEATURES,
  type GuildSettingsSnapshot,
} from '../../core/guild-settings';

const nestedOptions = { _id: false, strict: 'throw' as const };
const featureSchema = new Schema(
  {
    enabled: { type: Boolean, required: true },
    mode: { type: String, enum: ['all', 'allowlist'], required: true },
    channelIds: { type: [String], required: true },
    excludedChannelIds: { type: [String], required: true },
  },
  nestedOptions,
);
const entertainmentCommandSchema = new Schema(
  {
    enabled: { type: Boolean, required: true, default: true },
    cooldownSeconds: { type: Number, required: true, min: 0, max: 86400, default: 0 },
  },
  nestedOptions,
);
const settingsSchema = new Schema(
  {
    general: {
      type: new Schema(
        {
          language: { type: String, required: true, enum: ['inherit', 'en', 'zh-TW'] },
          timeZone: { type: String, default: null },
        },
        nestedOptions,
      ),
      required: true,
      default: () => ({ language: 'inherit', timeZone: null }),
    },
    entertainment: {
      type: new Schema(
        Object.fromEntries(
          ENTERTAINMENT_COMMANDS.map((command) => [
            command,
            {
              type: entertainmentCommandSchema,
              required: true,
              default: () => ({ enabled: true, cooldownSeconds: 0 }),
            },
          ]),
        ),
        nestedOptions,
      ),
      required: true,
      default: () => ({}),
    },
    moderationVote: {
      type: new Schema(
        {
          threshold: { type: Number, required: true, min: 2, max: 50 },
          voteWindowSeconds: { type: Number, required: true, min: 10, max: 600 },
          durationMinutes: { type: Number, required: true, min: 1, max: 5 },
          voterRoleIds: { type: [String], required: true },
        },
        nestedOptions,
      ),
      required: true,
      default: () => ({
        threshold: 5,
        voteWindowSeconds: 60,
        durationMinutes: 1,
        voterRoleIds: [],
      }),
    },
    features: {
      type: new Schema(
        Object.fromEntries(
          FEATURES.map((feature) => [feature, { type: featureSchema, required: true }]),
        ),
        nestedOptions,
      ),
      required: true,
    },
    access: {
      type: new Schema(
        {
          mode: { type: String, enum: ['managers', 'roles', 'everyone'], required: true },
          roleIds: { type: [String], required: true },
          categories: { type: [String], enum: CATEGORIES, required: true },
        },
        nestedOptions,
      ),
      required: true,
    },
    channels: {
      type: new Schema(
        {
          debug: { type: String, default: null },
          event: { type: String, default: null },
          giveaway: { type: String, default: null },
        },
        nestedOptions,
      ),
      required: true,
    },
    autoReply: {
      type: new Schema(
        {
          keywords: { type: Boolean, required: true },
          lucky: { type: Boolean, required: true },
          random: { type: Boolean, required: true },
          dice: { type: Boolean, required: true },
          reactions: { type: Boolean, required: true },
          probability: { type: Number, required: true, min: 0, max: 1 },
          cooldownSeconds: { type: Number, required: true, min: 0, max: 86400 },
        },
        nestedOptions,
      ),
      required: true,
    },
    socialPreview: {
      type: new Schema(
        {
          providers: { type: [String], required: true },
          originalMessageStrategy: {
            type: String,
            enum: ['suppress', 'leave', 'delete'],
            required: true,
          },
          maxUrlsPerMessage: { type: Number, required: true, min: 1, max: 5 },
          videoEnabled: { type: Boolean, required: true },
        },
        nestedOptions,
      ),
      required: true,
    },
  },
  nestedOptions,
);
const auditSchema = new Schema(
  {
    operationId: { type: String, required: true },
    revision: { type: Number, required: true },
    userId: { type: String, required: true },
    at: { type: Number, required: true },
    paths: { type: [String], required: true },
  },
  nestedOptions,
);
export type GuildSettingsDoc = GuildSettingsSnapshot & {
  readonly schemaVersion: number;
  readonly updatedAt: number;
  readonly updatedBy: string | null;
};
export const guildSettingsSchema = new Schema<GuildSettingsDoc>(
  {
    schemaVersion: {
      type: Number,
      required: true,
      enum: [1, GUILD_SETTINGS_SCHEMA_VERSION],
      default: GUILD_SETTINGS_SCHEMA_VERSION,
    },
    updatedAt: { type: Number, required: true, default: Date.now },
    updatedBy: { type: String, default: null },
    botId: { type: String, required: true },
    guildId: { type: String, required: true },
    revision: { type: Number, required: true, min: 0 },
    settings: { type: settingsSchema, required: true },
    audit: { type: [auditSchema], required: true },
    lastOperationId: { type: String, required: true },
  },
  { strict: 'throw', versionKey: false },
);
guildSettingsSchema.index({ botId: 1, guildId: 1 }, { unique: true });
export interface GuildSettingsMigrationDoc {
  readonly botId: string;
  readonly guildIds: readonly string[];
  readonly createdAt: number;
}
export const guildSettingsMigrationSchema = new Schema<GuildSettingsMigrationDoc>(
  {
    botId: { type: String, required: true, unique: true },
    guildIds: { type: [String], required: true },
    createdAt: { type: Number, required: true },
  },
  { strict: 'throw', versionKey: false },
);
