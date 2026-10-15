import type { DatabaseError } from '../../core/errors/external-service-error';
import {
  normalizeGuildSettings,
  upgradeGuildSettings,
  GUILD_SETTINGS_SCHEMA_VERSION,
  UPGRADABLE_GUILD_SETTINGS_VERSIONS,
  type GuildSettings,
  type GuildSettingsAudit,
  type GuildSettingsSnapshot,
} from '../../core/guild-settings';
import { err, ok, type Result } from '../../core/result';
import type { GuildConnection } from '../connection';
import { databaseErrorFrom } from '../error-translator';
import type { GuildSettingsMigrationDoc } from '../schemas/guild-settings.schema';

export interface GuildSettingsRepo {
  find(
    botId: string,
    guildId: string,
  ): Promise<Result<GuildSettingsSnapshot | undefined, DatabaseError>>;
  seed(snapshot: GuildSettingsSnapshot): Promise<Result<GuildSettingsSnapshot, DatabaseError>>;
  compareAndSwap(
    botId: string,
    guildId: string,
    expectedRevision: number,
    settings: GuildSettings,
    audit: GuildSettingsAudit,
  ): Promise<Result<GuildSettingsSnapshot | undefined, DatabaseError>>;
  getMigration(
    botId: string,
  ): Promise<Result<GuildSettingsMigrationDoc | undefined, DatabaseError>>;
  fixMigration(
    botId: string,
    guildIds: readonly string[],
  ): Promise<Result<GuildSettingsMigrationDoc, DatabaseError>>;
}
const snapshotFrom = (document: GuildSettingsSnapshot): GuildSettingsSnapshot => {
  if (document.schemaVersion !== GUILD_SETTINGS_SCHEMA_VERSION)
    throw new Error('Unsupported guild settings schema version');
  return {
    schemaVersion: document.schemaVersion,
    updatedAt: document.updatedAt ?? 0,
    updatedBy: document.updatedBy ?? null,
    botId: document.botId,
    guildId: document.guildId,
    revision: document.revision,
    settings: normalizeGuildSettings(document.settings),
    audit: document.audit.map((entry) => ({
      operationId: entry.operationId,
      revision: entry.revision,
      userId: entry.userId,
      at: entry.at,
      paths: [...entry.paths],
    })),
    lastOperationId: document.lastOperationId,
  };
};
export class MongoGuildSettingsRepo implements GuildSettingsRepo {
  constructor(private readonly conn: GuildConnection) {}
  async find(
    botId: string,
    guildId: string,
  ): Promise<Result<GuildSettingsSnapshot | undefined, DatabaseError>> {
    return this.run('find', () => this.loadLatest(botId, guildId));
  }

  async seed(
    snapshot: GuildSettingsSnapshot,
  ): Promise<Result<GuildSettingsSnapshot, DatabaseError>> {
    return this.run('seed', async () => {
      const settings = normalizeGuildSettings(snapshot.settings);
      await this.conn.models.GuildSettings.init();
      try {
        const doc = await this.conn.models.GuildSettings.findOneAndUpdate(
          { botId: snapshot.botId, guildId: snapshot.guildId },
          {
            $setOnInsert: {
              ...snapshot,
              settings,
              schemaVersion: GUILD_SETTINGS_SCHEMA_VERSION,
              updatedAt: Date.now(),
              updatedBy: null,
            },
          },
          { upsert: true, new: true, runValidators: true },
        )
          .lean<GuildSettingsSnapshot>()
          .exec();
        if (!doc) throw new Error('Seed returned no document');
        return (await this.loadLatest(snapshot.botId, snapshot.guildId)) ?? snapshotFrom(doc);
      } catch (error: unknown) {
        if (!(error instanceof Error && 'code' in error && error.code === 11000)) throw error;
        const doc = await this.conn.models.GuildSettings.findOne({
          botId: snapshot.botId,
          guildId: snapshot.guildId,
        })
          .lean<GuildSettingsSnapshot>()
          .exec();
        if (!doc) throw error;
        return (await this.loadLatest(snapshot.botId, snapshot.guildId)) ?? snapshotFrom(doc);
      }
    });
  }
  async compareAndSwap(
    botId: string,
    guildId: string,
    expectedRevision: number,
    settings: GuildSettings,
    audit: GuildSettingsAudit,
  ): Promise<Result<GuildSettingsSnapshot | undefined, DatabaseError>> {
    return this.run('compareAndSwap', async () => {
      const validated = normalizeGuildSettings(settings);
      await this.loadLatest(botId, guildId);
      if (audit.revision !== expectedRevision + 1) throw new Error('Invalid audit revision');
      const doc = await this.conn.models.GuildSettings.findOneAndUpdate(
        {
          botId,
          guildId,
          schemaVersion: GUILD_SETTINGS_SCHEMA_VERSION,
          revision: expectedRevision,
          'audit.operationId': { $ne: audit.operationId },
        },
        {
          $set: {
            settings: validated,
            lastOperationId: audit.operationId,
            updatedAt: audit.at,
            updatedBy: audit.userId,
          },
          $inc: { revision: 1 },
          $push: { audit: { $each: [audit], $slice: -50 } },
        },
        { new: true, runValidators: true },
      )
        .lean<GuildSettingsSnapshot>()
        .exec();
      return doc ? snapshotFrom(doc) : undefined;
    });
  }
  async getMigration(
    botId: string,
  ): Promise<Result<GuildSettingsMigrationDoc | undefined, DatabaseError>> {
    return this.run('getMigration', async () => {
      const doc = await this.conn.models.GuildSettingsMigration.findOne({ botId })
        .lean<GuildSettingsMigrationDoc>()
        .exec();
      return doc
        ? { botId: doc.botId, guildIds: [...doc.guildIds], createdAt: doc.createdAt }
        : undefined;
    });
  }
  async fixMigration(
    botId: string,
    guildIds: readonly string[],
  ): Promise<Result<GuildSettingsMigrationDoc, DatabaseError>> {
    return this.run('fixMigration', async () => {
      await this.conn.models.GuildSettingsMigration.init();
      try {
        const doc = await this.conn.models.GuildSettingsMigration.findOneAndUpdate(
          { botId },
          { $setOnInsert: { botId, guildIds: [...new Set(guildIds)], createdAt: Date.now() } },
          { upsert: true, new: true, runValidators: true },
        )
          .lean<GuildSettingsMigrationDoc>()
          .exec();
        if (!doc) throw new Error('Migration inventory returned no document');
        return { botId: doc.botId, guildIds: [...doc.guildIds], createdAt: doc.createdAt };
      } catch (error: unknown) {
        if (!(error instanceof Error && 'code' in error && error.code === 11000)) throw error;
        const doc = await this.conn.models.GuildSettingsMigration.findOne({ botId })
          .lean<GuildSettingsMigrationDoc>()
          .exec();
        if (!doc) throw error;
        return { botId: doc.botId, guildIds: [...doc.guildIds], createdAt: doc.createdAt };
      }
    });
  }
  private async loadLatest(
    botId: string,
    guildId: string,
  ): Promise<GuildSettingsSnapshot | undefined> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const document = await this.conn.models.GuildSettings.findOne({ botId, guildId })
        .lean<GuildSettingsSnapshot>()
        .exec();
      if (!document) return undefined;
      if (document.schemaVersion === GUILD_SETTINGS_SCHEMA_VERSION) return snapshotFrom(document);
      if (!UPGRADABLE_GUILD_SETTINGS_VERSIONS.includes(document.schemaVersion ?? 0))
        throw new Error('Unsupported guild settings schema version');
      const settings = upgradeGuildSettings(document.schemaVersion ?? 0, document.settings);
      try {
        const upgraded = await this.conn.models.GuildSettings.findOneAndUpdate(
          {
            botId,
            guildId,
            schemaVersion: document.schemaVersion,
            revision: document.revision,
            lastOperationId: document.lastOperationId,
          },
          { $set: { schemaVersion: GUILD_SETTINGS_SCHEMA_VERSION, settings } },
          { new: true, runValidators: true },
        )
          .lean<GuildSettingsSnapshot>()
          .exec();
        if (upgraded) return snapshotFrom(upgraded);
      } catch (error: unknown) {
        const latest = await this.conn.models.GuildSettings.findOne({ botId, guildId })
          .lean<GuildSettingsSnapshot>()
          .exec();
        if (latest?.schemaVersion === GUILD_SETTINGS_SCHEMA_VERSION) return snapshotFrom(latest);
        throw error;
      }
    }
    throw new Error('Guild settings upgrade conflicted repeatedly');
  }
  private async run<T>(
    operation: string,
    action: () => Promise<T>,
  ): Promise<Result<T, DatabaseError>> {
    try {
      return ok(await action());
    } catch (error: unknown) {
      return err(databaseErrorFrom(error, { operation: `MongoGuildSettingsRepo.${operation}` }));
    }
  }
}
