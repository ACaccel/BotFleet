import { describe, expect, it, vi } from 'vitest';
import {
  FEATURES,
  GUILD_SETTINGS_SCHEMA_VERSION,
  defaultGuildSettings,
  type GuildSettingsSnapshot,
  type OperatorCapabilities,
} from '../../../src/core/guild-settings';
import { asGuildId } from '../../../src/core/ids';
import { unwrap } from '../../../src/core/result';
import { StaticConnectionManager } from '../../../src/infra/mongo/connection-manager';
import { MongoGuildSettingsRepo } from '../../../src/persistence/repositories/guild-settings.repo';
import { withFreshConnection } from '../helpers/mongo';
import type { GuildConnection } from '../../../src/persistence/connection';
const guildId = '200000000000000001';
const botId = '100000000000000001';
const caps: OperatorCapabilities = {
  features: Object.fromEntries(FEATURES.map((feature) => [feature, true])) as Record<
    (typeof FEATURES)[number],
    boolean
  >,
  socialProviders: ['x'],
  maxRandomProbability: 0.05,
  minCooldownSeconds: 2,
  maxPreviewUrls: 5,
};
const seed = (bot = botId): GuildSettingsSnapshot => ({
  botId: bot,
  guildId,
  revision: 0,
  settings: defaultGuildSettings(caps),
  audit: [],
  lastOperationId: 'seed',
});
const installLegacyDocument = async (guild: GuildConnection): Promise<MongoGuildSettingsRepo> => {
  const repo = new MongoGuildSettingsRepo(guild);
  unwrap(await repo.seed(seed()));
  await guild.models.GuildSettings.collection.updateOne(
    { botId, guildId },
    {
      $set: {
        schemaVersion: 1,
        revision: 4,
        updatedAt: 123,
        updatedBy: '500000000000000001',
        lastOperationId: 'previous',
        audit: [
          {
            operationId: 'previous',
            revision: 4,
            userId: '500000000000000001',
            at: 123,
            paths: ['autoReply.dice'],
          },
        ],
        'settings.autoReply.dice': false,
      },
      $unset: {
        'settings.general': '',
        'settings.entertainment': '',
        'settings.moderationVote': '',
        'settings.earthquake': '',
      },
    },
  );
  return repo;
};
describe('MongoGuildSettingsRepo', () => {
  it('upgrades v3 without enabling earthquake delivery and removes the retired reply flag', async () => {
    await withFreshConnection(async (connection) => {
      const guild = await new StaticConnectionManager(connection).getConnection(asGuildId(guildId));
      const repo = new MongoGuildSettingsRepo(guild);
      unwrap(await repo.seed(seed()));
      await guild.models.GuildSettings.collection.updateOne(
        { botId, guildId },
        {
          $set: { schemaVersion: 3, revision: 7, 'settings.autoReply.lucky': true },
          $unset: { 'settings.earthquake': '' },
        },
      );
      const upgraded = unwrap(await repo.find(botId, guildId));
      expect(upgraded?.revision).toBe(7);
      expect(upgraded?.schemaVersion).toBe(GUILD_SETTINGS_SCHEMA_VERSION);
      expect(upgraded?.settings.earthquake).toEqual({
        alertsEnabled: false,
        reportsEnabled: false,
        channelId: null,
        roleId: null,
      });
      expect(upgraded?.settings.autoReply).not.toHaveProperty('lucky');
      const settings = defaultGuildSettings(caps);
      settings.earthquake = {
        alertsEnabled: true,
        reportsEnabled: true,
        channelId: '400000000000000001',
        roleId: null,
      };
      unwrap(
        await repo.compareAndSwap(botId, guildId, 7, settings, {
          operationId: 'enable-earthquake',
          revision: 8,
          userId: '500000000000000001',
          at: 1,
          paths: ['earthquake.alertsEnabled'],
        }),
      );
      expect(
        unwrap(await new MongoGuildSettingsRepo(guild).find(botId, guildId))?.settings.earthquake,
      ).toEqual(settings.earthquake);
    });
  });
  it('upgrades v1 structurally while preserving revision, audit, operation and explicit legacy preferences', async () => {
    await withFreshConnection(async (connection) => {
      const guild = await new StaticConnectionManager(connection).getConnection(asGuildId(guildId));
      const repo = await installLegacyDocument(guild);
      const upgraded = unwrap(await repo.find(botId, guildId));
      expect(upgraded).toMatchObject({
        schemaVersion: GUILD_SETTINGS_SCHEMA_VERSION,
        revision: 4,
        updatedAt: 123,
        updatedBy: '500000000000000001',
        lastOperationId: 'previous',
      });
      expect(upgraded?.audit).toHaveLength(1);
      expect(upgraded?.audit[0]?.operationId).toBe('previous');
      expect(upgraded?.settings.autoReply.dice).toBe(false);
      expect(upgraded?.settings.general).toEqual({ language: 'inherit', timeZone: null });
      expect(upgraded?.settings.earthquake).toEqual({
        alertsEnabled: false,
        reportsEnabled: false,
        channelId: null,
        roleId: null,
      });
      expect(upgraded?.settings.moderationVote).toEqual({
        threshold: 5,
        voteWindowSeconds: 60,
        durationMinutes: 1,
        voterRoleIds: [],
      });
      const restarted = new MongoGuildSettingsRepo(guild);
      expect(unwrap(await restarted.find(botId, guildId))).toEqual(upgraded);
      expect(
        (await guild.models.GuildSettings.findOne({ botId, guildId }).lean().exec())?.schemaVersion,
      ).toBe(GUILD_SETTINGS_SCHEMA_VERSION);
    });
  });
  it('opens the gallery previews once on a v2 record and keeps a later opt-out', async () => {
    await withFreshConnection(async (connection) => {
      const guild = await new StaticConnectionManager(connection).getConnection(asGuildId(guildId));
      const repo = new MongoGuildSettingsRepo(guild);
      unwrap(await repo.seed(seed()));
      await guild.models.GuildSettings.collection.updateOne(
        { botId, guildId },
        { $set: { schemaVersion: 2, revision: 3, 'settings.socialPreview.providers': ['x'] } },
      );

      const upgraded = unwrap(await repo.find(botId, guildId));
      expect(upgraded?.schemaVersion).toBe(GUILD_SETTINGS_SCHEMA_VERSION);
      expect(upgraded?.revision).toBe(3);
      expect(upgraded?.settings.socialPreview.providers).toEqual(['x', 'nhentai', 'wnacg']);

      const optedOut = defaultGuildSettings(caps);
      optedOut.socialPreview.providers = ['x'];
      unwrap(
        await repo.compareAndSwap(botId, guildId, 3, optedOut, {
          operationId: 'opt-out',
          revision: 4,
          userId: '500000000000000001',
          at: 1,
          paths: ['socialPreview.providers'],
        }),
      );
      const restarted = new MongoGuildSettingsRepo(guild);
      expect(
        unwrap(await restarted.find(botId, guildId))?.settings.socialPreview.providers,
      ).toEqual(['x']);
    });
  });
  it('does not overwrite a new user edit when concurrent readers upgrade the same legacy revision', async () => {
    await withFreshConnection(async (connection) => {
      const guild = await new StaticConnectionManager(connection).getConnection(asGuildId(guildId));
      const repo = await installLegacyDocument(guild);
      const settings = defaultGuildSettings(caps);
      settings.autoReply.dice = false;
      settings.general = { language: 'en', timeZone: 'Europe/London' };
      const [, , edit] = await Promise.all([
        repo.find(botId, guildId),
        repo.find(botId, guildId),
        repo.compareAndSwap(botId, guildId, 4, settings, {
          operationId: 'editor',
          revision: 5,
          userId: '500000000000000001',
          at: 200,
          paths: ['general.language', 'general.timeZone'],
        }),
      ]);
      expect(unwrap(edit)?.revision).toBe(5);
      const after = unwrap(await repo.find(botId, guildId));
      expect(after?.settings.general).toEqual({ language: 'en', timeZone: 'Europe/London' });
      expect(after?.settings.autoReply.dice).toBe(false);
      expect(after?.audit.map((audit) => audit.operationId)).toEqual(['previous', 'editor']);
    });
  });
  it('retries a structural upgrade against the latest revision when a v1 writer changes preferences first', async () => {
    await withFreshConnection(async (connection) => {
      const guild = await new StaticConnectionManager(connection).getConnection(asGuildId(guildId));
      const repo = await installLegacyDocument(guild);
      const update = guild.models.GuildSettings.collection.findOneAndUpdate.bind(
        guild.models.GuildSettings.collection,
      );
      vi.spyOn(guild.models.GuildSettings.collection, 'findOneAndUpdate').mockImplementationOnce(
        async (...args) => {
          await guild.models.GuildSettings.collection.updateOne(
            { botId, guildId, schemaVersion: 1, revision: 4 },
            {
              $set: { 'settings.autoReply.random': false, lastOperationId: 'legacy-editor' },
              $inc: { revision: 1 },
            },
          );
          return update(...args);
        },
      );
      const upgraded = unwrap(await repo.find(botId, guildId));
      expect(upgraded?.schemaVersion).toBe(GUILD_SETTINGS_SCHEMA_VERSION);
      expect(upgraded?.revision).toBe(5);
      expect(upgraded?.lastOperationId).toBe('legacy-editor');
      expect(upgraded?.settings.autoReply.random).toBe(false);
      expect(upgraded?.settings.autoReply.dice).toBe(false);
    });
  });
  it('reconciles a lost structural upgrade acknowledgement from the persisted version', async () => {
    await withFreshConnection(async (connection) => {
      const guild = await new StaticConnectionManager(connection).getConnection(asGuildId(guildId));
      const repo = await installLegacyDocument(guild);
      const update = guild.models.GuildSettings.collection.findOneAndUpdate.bind(
        guild.models.GuildSettings.collection,
      );
      vi.spyOn(guild.models.GuildSettings.collection, 'findOneAndUpdate').mockImplementationOnce(
        async (...args) => {
          await update(...args);
          throw new Error('Upgrade acknowledgement lost');
        },
      );
      const upgraded = unwrap(await repo.find(botId, guildId));
      expect(upgraded?.schemaVersion).toBe(GUILD_SETTINGS_SCHEMA_VERSION);
      expect(upgraded?.revision).toBe(4);
      expect(upgraded?.lastOperationId).toBe('previous');
      expect(upgraded?.settings.general).toEqual({ language: 'inherit', timeZone: null });
    });
  });
  it('upgrades legacy state before applying a cancellation fence without changing its preferences', async () => {
    await withFreshConnection(async (connection) => {
      const guild = await new StaticConnectionManager(connection).getConnection(asGuildId(guildId));
      const repo = await installLegacyDocument(guild);
      const settings = defaultGuildSettings(caps);
      settings.autoReply.dice = false;
      const fenced = unwrap(
        await repo.compareAndSwap(botId, guildId, 4, settings, {
          operationId: 'cancelled',
          revision: 5,
          userId: '500000000000000001',
          at: 200,
          paths: [],
        }),
      );
      expect(fenced?.schemaVersion).toBe(GUILD_SETTINGS_SCHEMA_VERSION);
      expect(fenced?.lastOperationId).toBe('cancelled');
      expect(fenced?.settings.autoReply.dice).toBe(false);
      expect(fenced?.audit.at(-1)?.paths).toEqual([]);
    });
  });
  it('rejects malformed settings without changing the committed revision', async () => {
    await withFreshConnection(async (connection) => {
      const repo = new MongoGuildSettingsRepo(
        await new StaticConnectionManager(connection).getConnection(asGuildId(guildId)),
      );
      const initial = unwrap(await repo.seed(seed()));
      const invalid = defaultGuildSettings(caps);
      invalid.autoReply.probability = 2;
      const result = await repo.compareAndSwap(botId, guildId, 0, invalid, {
        operationId: 'invalid',
        revision: 1,
        userId: '500000000000000001',
        at: 5,
        paths: ['autoReply.probability'],
      });
      expect(result.ok).toBe(false);
      const after = unwrap(await repo.find(botId, guildId));
      expect(after?.revision).toBe(0);
      expect(after?.schemaVersion).toBe(GUILD_SETTINGS_SCHEMA_VERSION);
      expect(after?.updatedAt).toBe(initial.updatedAt);
      expect(after?.updatedBy).toBeNull();
    });
  });

  it('refuses to apply a document using an unsupported future schema version', async () => {
    await withFreshConnection(async (connection) => {
      const guild = await new StaticConnectionManager(connection).getConnection(asGuildId(guildId));
      const repo = new MongoGuildSettingsRepo(guild);
      unwrap(await repo.seed(seed()));
      await guild.models.GuildSettings.collection.updateOne(
        { botId, guildId },
        { $set: { schemaVersion: GUILD_SETTINGS_SCHEMA_VERSION + 1 } },
      );
      const result = await repo.find(botId, guildId);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.cause).toBeInstanceOf(Error);
      const write = await repo.compareAndSwap(botId, guildId, 0, defaultGuildSettings(caps), {
        operationId: 'unsupported',
        revision: 1,
        userId: '500000000000000001',
        at: 0,
        paths: [],
      });
      expect(write.ok).toBe(false);
      expect(
        (await guild.models.GuildSettings.findOne({ botId, guildId }).lean().exec())?.revision,
      ).toBe(0);
    });
  });
  it('isolates applications, preserves explicit clears, and rejects competing revisions atomically', async () => {
    await withFreshConnection(async (connection) => {
      const repo = new MongoGuildSettingsRepo(
        await new StaticConnectionManager(connection).getConnection(asGuildId(guildId)),
      );
      await Promise.all([repo.seed(seed()), repo.seed(seed())]);
      unwrap(await repo.seed(seed('100000000000000002')));
      const settings = defaultGuildSettings(caps);
      settings.channels.debug = null;
      settings.autoReply.dice = false;
      const writes = await Promise.all(
        ['one', 'two'].map((operationId) =>
          repo.compareAndSwap(botId, guildId, 0, settings, {
            operationId,
            revision: 1,
            userId: '500000000000000001',
            at: 0,
            paths: ['autoReply.dice'],
          }),
        ),
      );
      expect(writes.filter((result) => unwrap(result) !== undefined)).toHaveLength(1);
      expect(unwrap(await repo.find(botId, guildId))?.revision).toBe(1);
      expect(unwrap(await repo.find('100000000000000002', guildId))?.revision).toBe(0);
      const reSeed = unwrap(await repo.seed(seed()));
      expect(reSeed.settings.autoReply.dice).toBe(false);
      expect(reSeed.settings.channels.debug).toBeNull();
    });
  });
  it.each(['original', 'fence'] as const)(
    'revision fencing preserves the %s winner against the late write',
    async (winner) => {
      await withFreshConnection(async (connection) => {
        const repo = new MongoGuildSettingsRepo(
          await new StaticConnectionManager(connection).getConnection(asGuildId(guildId)),
        );
        const committed = unwrap(await repo.seed(seed()));
        const changed = defaultGuildSettings(caps);
        changed.autoReply.dice = false;
        const writeOriginal = () =>
          repo.compareAndSwap(botId, guildId, 0, changed, {
            operationId: 'original',
            revision: 1,
            userId: '500000000000000001',
            at: 0,
            paths: ['autoReply.dice'],
          });
        const writeFence = () =>
          repo.compareAndSwap(botId, guildId, 0, committed.settings, {
            operationId: 'fence',
            revision: 1,
            userId: '500000000000000001',
            at: 0,
            paths: [],
          });
        const first = winner === 'original' ? writeOriginal : writeFence;
        const late = winner === 'original' ? writeFence : writeOriginal;
        expect(unwrap(await first())?.lastOperationId).toBe(winner);
        expect(unwrap(await late())).toBeUndefined();
        const after = unwrap(await repo.find(botId, guildId));
        expect(after?.revision).toBe(1);
        expect(after?.settings.autoReply.dice).toBe(winner === 'fence');
        expect(after?.audit).toHaveLength(1);
        expect(after?.audit[0]?.paths).toEqual(winner === 'fence' ? [] : ['autoReply.dice']);
      });
    },
  );
  it('bounds audit history and never reapplies a persisted operation', async () => {
    await withFreshConnection(async (connection) => {
      const repo = new MongoGuildSettingsRepo(
        await new StaticConnectionManager(connection).getConnection(asGuildId(guildId)),
      );
      unwrap(await repo.seed(seed()));
      const settings = defaultGuildSettings(caps);
      for (let index = 0; index < 55; index++) {
        unwrap(
          await repo.compareAndSwap(botId, guildId, index, settings, {
            operationId: `operation-${index}`,
            revision: index + 1,
            userId: '500000000000000001',
            at: index,
            paths: ['autoReply.dice'],
          }),
        );
      }
      const snapshot = unwrap(await repo.find(botId, guildId));
      expect(snapshot?.audit).toHaveLength(50);
      expect(snapshot?.audit[0]?.operationId).toBe('operation-5');
      expect(
        unwrap(
          await repo.compareAndSwap(botId, guildId, 55, settings, {
            operationId: 'operation-54',
            revision: 56,
            userId: '500000000000000001',
            at: 0,
            paths: [],
          }),
        ),
      ).toBeUndefined();
      expect(unwrap(await repo.find(botId, guildId))?.revision).toBe(55);
    });
  });
  it('fixes legacy membership once and isolates each application inventory', async () => {
    await withFreshConnection(async (connection) => {
      const repo = new MongoGuildSettingsRepo(
        await new StaticConnectionManager(connection).getConnection(asGuildId(guildId)),
      );
      const initial = unwrap(await repo.fixMigration(botId, [guildId]));
      const later = unwrap(await repo.fixMigration(botId, [guildId, '200000000000000002']));
      expect(later).toEqual(initial);
      const other = unwrap(await repo.fixMigration('100000000000000002', []));
      expect(other.guildIds).toEqual([]);
      expect(unwrap(await repo.getMigration(botId))?.guildIds).toEqual([guildId]);
    });
  });
});
