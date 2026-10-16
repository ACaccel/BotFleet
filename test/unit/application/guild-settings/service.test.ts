import { describe, expect, it, vi } from 'vitest';
import {
  GuildSettingsService,
  type GuildSettingsActorIdentity,
} from '../../../../src/application/guild-settings/service';
import { GuildSettingsSessions } from '../../../../src/application/guild-settings/session';
import {
  FEATURES,
  GuildSettingsError,
  cloneSettings,
  defaultGuildSettings,
  type GuildSettings,
  type GuildSettingsActor,
  type GuildSettingsAudit,
  type GuildSettingsSnapshot,
  type OperatorCapabilities,
} from '../../../../src/core/guild-settings';
import { err, ok } from '../../../../src/core/result';
import { databaseErrorFrom } from '../../../../src/persistence/error-translator';
import type { GuildSettingsRepo } from '../../../../src/persistence/repositories/guild-settings.repo';
import type { GuildSettingsMigrationDoc } from '../../../../src/persistence/schemas/guild-settings.schema';

const botId = '100000000000000001';
const guildId = '200000000000000001';
const otherGuild = '200000000000000002';
const roleId = '300000000000000001';
const channelId = '400000000000000001';
const actor: GuildSettingsActor = {
  botId,
  guildId,
  userId: '500000000000000001',
  manager: true,
  roleIds: [],
};
const caps: OperatorCapabilities = {
  features: Object.fromEntries(FEATURES.map((feature) => [feature, true])) as Record<
    (typeof FEATURES)[number],
    boolean
  >,
  socialProviders: ['x', 'pixiv'],
  maxRandomProbability: 0.05,
  minCooldownSeconds: 2,
  maxPreviewUrls: 5,
};
const databaseError = () =>
  databaseErrorFrom(new Error('Lost acknowledgement'), { operation: 'test' });
class MemoryRepo implements GuildSettingsRepo {
  readonly documents = new Map<string, GuildSettingsSnapshot>();
  inventory: GuildSettingsMigrationDoc | undefined;
  ambiguous = false;
  readsFail = false;
  private key(bot: string, guild: string): string {
    return `${bot}:${guild}`;
  }
  async find(bot: string, guild: string) {
    return this.readsFail ? err(databaseError()) : ok(this.documents.get(this.key(bot, guild)));
  }
  async seed(snapshot: GuildSettingsSnapshot) {
    const key = this.key(snapshot.botId, snapshot.guildId);
    const existing = this.documents.get(key);
    if (!existing) this.documents.set(key, structuredClone(snapshot));
    return ok(this.documents.get(key)!);
  }
  async compareAndSwap(
    bot: string,
    guild: string,
    revision: number,
    settings: GuildSettings,
    audit: GuildSettingsAudit,
  ) {
    const key = this.key(bot, guild);
    const previous = this.documents.get(key);
    if (!previous || previous.revision !== revision) return ok(undefined);
    const next: GuildSettingsSnapshot = {
      ...previous,
      settings: cloneSettings(settings),
      revision: revision + 1,
      lastOperationId: audit.operationId,
      audit: [...previous.audit, audit].slice(-50),
    };
    this.documents.set(key, next);
    if (this.ambiguous) return err(databaseError());
    return ok(next);
  }
  async getMigration() {
    return ok(this.inventory);
  }
  async fixMigration(
    bot: string,
    guildIds: readonly string[],
  ): ReturnType<GuildSettingsRepo['fixMigration']> {
    this.inventory ??= { botId: bot, guildIds: [...guildIds], createdAt: 0 };
    return ok(this.inventory);
  }
}
const setup = async (
  repo = new MemoryRepo(),
  guilds: readonly string[] = [guildId],
  now?: () => number,
  capabilities: OperatorCapabilities = caps,
) => {
  const service = new GuildSettingsService({
    botId,
    repo: () => repo,
    migrationRepo: () => repo,
    capabilities,
    legacySeed: () => {
      const settings = defaultGuildSettings(caps);
      settings.features.auto_reply.enabled = true;
      return settings;
    },
    ...(now ? { now } : {}),
  });
  await service.initialize(guilds);
  return { repo, service };
};

type RecoveryAuthorityState = 'active' | 'revoked' | 'left' | 'network' | 'spoof';
const setupPendingAuthority = async () => {
  const repo = new MemoryRepo();
  const editor: GuildSettingsActor = {
    ...actor,
    userId: '500000000000000002',
    manager: false,
    roleIds: [roleId],
  };
  let authority: RecoveryAuthorityState = 'active';
  let resourceDenied = false;
  const resolveActor = vi.fn(
    async (identity: GuildSettingsActorIdentity): Promise<GuildSettingsActor> => {
      if (identity.userId === actor.userId) return actor;
      if (authority === 'network') throw new Error('Membership request timed out');
      if (authority === 'left') throw new GuildSettingsError('forbidden');
      if (authority === 'spoof') return { ...editor, userId: actor.userId };
      return authority === 'revoked' ? { ...editor, roleIds: [] } : editor;
    },
  );
  const validateResources = vi.fn(async () => {
    if (resourceDenied) throw new GuildSettingsError('forbidden');
  });
  const service = new GuildSettingsService({
    botId,
    capabilities: caps,
    repo: () => repo,
    migrationRepo: () => repo,
    legacySeed: () => defaultGuildSettings(caps),
    resolveActor,
    validateResources,
  });
  await service.initialize([guildId]);
  const manager = await service.open(actor);
  manager.draft.access = { mode: 'roles', roleIds: [roleId], categories: ['auto_reply'] };
  await service.save(manager.id, actor);
  const session = await service.open(editor);
  session.draft.autoReply.dice = false;
  let original: Parameters<MemoryRepo['compareAndSwap']> | undefined;
  vi.spyOn(repo, 'compareAndSwap').mockImplementationOnce(async (...args) => {
    original = args;
    repo.readsFail = true;
    return err(databaseError());
  });
  await expect(service.save(session.id, editor)).rejects.toMatchObject({ code: 'pending' });
  repo.readsFail = false;
  return {
    service,
    repo,
    session,
    editor,
    resolveActor,
    validateResources,
    original: original!,
    setAuthority: (state: RecoveryAuthorityState) => {
      authority = state;
    },
    denyResources: () => {
      resourceDenied = true;
    },
  };
};

describe('GuildSettingsService', () => {
  it('fixes migration membership before hydration and gives later arrivals safety defaults after restart', async () => {
    const first = await setup();
    expect(first.service.isEnabled(guildId, 'auto_reply')).toBe(true);
    await first.service.ensureGuild(otherGuild);
    expect(first.service.isEnabled(otherGuild, 'auto_reply')).toBe(false);
    const restarted = await setup(first.repo, [guildId, otherGuild]);
    expect(restarted.repo.inventory?.guildIds).toEqual([guildId]);
    expect(restarted.service.isEnabled(otherGuild, 'auto_reply')).toBe(false);
    expect(restarted.service.get(guildId)?.revision).toBe(0);
  });
  it('attempts every guild after fixing inventory even when one hydration fails', async () => {
    const repo = new MemoryRepo();
    const reads = vi
      .spyOn(repo, 'find')
      .mockImplementation(async (bot, guild) =>
        guild === guildId ? err(databaseError()) : MemoryRepo.prototype.find.call(repo, bot, guild),
      );
    const service = new GuildSettingsService({
      botId,
      repo: () => repo,
      migrationRepo: () => repo,
      capabilities: caps,
      legacySeed: () => defaultGuildSettings(caps),
    });
    await expect(service.initialize([guildId, otherGuild])).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(service.initialized).toBe(true);
    expect(reads.mock.calls.map((call) => call[1])).toEqual([guildId, otherGuild]);
    expect(service.get(guildId)).toBeUndefined();
    expect(service.get(otherGuild)?.revision).toBe(0);
  });
  it('keeps initialization unavailable when the migration marker cannot be fixed', async () => {
    const repo = new MemoryRepo();
    vi.spyOn(repo, 'fixMigration').mockResolvedValue(err(databaseError()));
    const service = new GuildSettingsService({
      botId,
      repo: () => repo,
      migrationRepo: () => repo,
      capabilities: caps,
      legacySeed: () => defaultGuildSettings(caps),
    });
    await expect(service.initialize([guildId])).rejects.toMatchObject({ code: 'unavailable' });
    expect(service.initialized).toBe(false);
    expect(service.get(guildId)).toBeUndefined();
  });
  it('rejects joins before migration initialization', async () => {
    const repo = new MemoryRepo();
    const service = new GuildSettingsService({
      botId,
      repo: () => repo,
      migrationRepo: () => repo,
      capabilities: caps,
      legacySeed: () => defaultGuildSettings(caps),
    });
    await expect(service.ensureGuild(guildId)).rejects.toMatchObject({ code: 'unavailable' });
    expect(repo.inventory).toBeUndefined();
  });
  it('keeps drafts separate, freezes runtime snapshots, and isolates guilds', async () => {
    const { service } = await setup();
    await service.ensureGuild(otherGuild);
    const session = await service.open(actor);
    const draft = cloneSettings(session.draft);
    draft.features.auto_reply.enabled = false;
    await service.stage(session.id, actor, draft);
    expect(service.isEnabled(guildId, 'auto_reply')).toBe(true);
    const saved = await service.save(session.id, actor);
    expect(service.isEnabled(guildId, 'auto_reply')).toBe(false);
    expect(service.get(otherGuild)?.revision).toBe(0);
    expect(Object.isFrozen(saved.settings.features.auto_reply)).toBe(true);
    expect(saved.audit[0]?.paths).toEqual(['features.auto_reply.enabled']);
  });
  it('does not regress runtime when an older hydration response arrives after a save', async () => {
    const { service, repo } = await setup();
    const session = await service.open(actor);
    const original = service.get(guildId)!;
    let release: () => void = () => {};
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(repo, 'find').mockImplementationOnce(async () => {
      await delayed;
      return ok(original);
    });
    const hydration = service.ensureGuild(guildId);
    await Promise.resolve();
    session.draft.autoReply.dice = false;
    await service.save(session.id, actor);
    release();
    expect((await hydration).revision).toBe(1);
    expect(service.get(guildId)?.settings.autoReply.dice).toBe(false);
  });
  it('rejects stale administrator drafts instead of replacing newer settings', async () => {
    const { service } = await setup();
    const first = await service.open(actor);
    const secondActor = { ...actor, userId: '500000000000000002' };
    const second = await service.open(secondActor);
    first.draft.autoReply.dice = false;
    await service.save(first.id, actor);
    second.draft.autoReply.reactions = false;
    await expect(service.save(second.id, secondActor)).rejects.toMatchObject({ code: 'conflict' });
    expect(service.get(guildId)?.settings.autoReply.reactions).toBe(true);
  });
  it('enforces delegated categories, protected fields and current role membership', async () => {
    const { service } = await setup();
    const manager = await service.open(actor);
    manager.draft.access = {
      mode: 'roles',
      roleIds: [roleId],
      categories: ['auto_reply', 'social_preview'],
    };
    await service.save(manager.id, actor);
    const editor = { ...actor, manager: false, userId: '500000000000000002', roleIds: [roleId] };
    const session = await service.open(editor);
    const draft = cloneSettings(session.draft);
    draft.autoReply.dice = false;
    await service.stage(session.id, editor, draft);
    await service.save(session.id, editor);
    draft.channels.debug = channelId;
    await expect(service.stage(session.id, editor, draft)).rejects.toMatchObject({
      code: 'forbidden',
    });
    const protectedDraft = cloneSettings(session.draft);
    protectedDraft.socialPreview.maxUrlsPerMessage = 2;
    await expect(service.stage(session.id, editor, protectedDraft)).rejects.toMatchObject({
      code: 'forbidden',
    });
    protectedDraft.socialPreview.maxUrlsPerMessage = 1;
    protectedDraft.socialPreview.originalMessageStrategy = 'delete';
    await expect(service.stage(session.id, editor, protectedDraft)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(service.save(session.id, { ...editor, roleIds: [] })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
  it('stages an incomplete manager role grant but requires roles before persistence', async () => {
    const { service, repo } = await setup();
    const session = await service.open(actor);
    const write = vi.spyOn(repo, 'compareAndSwap');
    const incomplete = cloneSettings(session.draft);
    incomplete.access.mode = 'roles';
    await service.stage(session.id, actor, incomplete);
    expect(session.draft.access.mode).toBe('roles');
    expect(service.get(guildId)?.settings.access.mode).toBe('managers');
    await expect(service.save(session.id, actor)).rejects.toMatchObject({ code: 'invalid' });
    expect(write).not.toHaveBeenCalled();
    const complete = cloneSettings(session.draft);
    complete.access.roleIds = [roleId];
    await service.stage(session.id, actor, complete);
    const saved = await service.save(session.id, actor);
    expect(saved.settings.access).toMatchObject({ mode: 'roles', roleIds: [roleId] });
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('delegates command preferences but protects general and moderation policies', async () => {
    const { service } = await setup();
    const manager = await service.open(actor);
    manager.draft.access = { mode: 'everyone', roleIds: [], categories: ['entertainment'] };
    await service.save(manager.id, actor);
    const editor = { ...actor, userId: '500000000000000002', manager: false };
    const session = await service.open(editor);
    const draft = cloneSettings(session.draft);
    draft.entertainment.gay = { enabled: false, cooldownSeconds: 30 };
    await service.stage(session.id, editor, draft);
    await service.save(session.id, editor);
    expect(service.get(guildId)?.settings.entertainment.gay).toEqual({
      enabled: false,
      cooldownSeconds: 30,
    });
    const general = cloneSettings(session.draft);
    general.general.language = 'en';
    await expect(service.stage(session.id, editor, general)).rejects.toMatchObject({
      code: 'forbidden',
    });
    const moderation = cloneSettings(session.draft);
    moderation.moderationVote.threshold = 10;
    await expect(service.stage(session.id, editor, moderation)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
  it('normalizes legacy adapter payloads in private drafts and effective snapshots', async () => {
    const { service, repo } = await setup();
    const snapshot = service.get(guildId)!;
    const {
      general: _general,
      entertainment: _entertainment,
      moderationVote: _moderation,
      ...legacy
    } = snapshot.settings;
    repo.documents.set(`${botId}:${guildId}`, { ...snapshot, settings: legacy as GuildSettings });
    await service.refreshGuild(guildId);
    expect(service.get(guildId)?.settings.general).toEqual({ language: 'inherit', timeZone: null });
    const session = await service.open(actor);
    expect(session.base.general).toEqual({ language: 'inherit', timeZone: null });
    expect(session.draft.entertainment.gay).toEqual({ enabled: true, cooldownSeconds: 0 });
    expect(session.draft.moderationVote.threshold).toBe(5);
  });
  it('keeps guild locale and moderation choices across service restarts', async () => {
    const { service, repo } = await setup();
    const session = await service.open(actor);
    session.draft.general = { language: 'zh-TW', timeZone: 'Asia/Taipei' };
    session.draft.moderationVote = {
      threshold: 8,
      voteWindowSeconds: 90,
      durationMinutes: 3,
      voterRoleIds: [roleId],
    };
    await service.save(session.id, actor);
    const restarted = await setup(repo);
    expect(restarted.service.get(guildId)?.settings.general).toEqual({
      language: 'zh-TW',
      timeZone: 'Asia/Taipei',
    });
    expect(restarted.service.get(guildId)?.settings.moderationVote).toEqual(
      session.draft.moderationVote,
    );
  });
  it('rejects invalid IANA zones before persisting a new draft', async () => {
    const { service, repo } = await setup();
    const session = await service.open(actor);
    const draft = cloneSettings(session.draft);
    draft.general.timeZone = 'Mars/Olympus';
    const write = vi.spyOn(repo, 'compareAndSwap');
    await expect(service.stage(session.id, actor, draft)).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(write).not.toHaveBeenCalled();
  });
  it('opens everyone preferences while requiring a separate manager access save', async () => {
    const { service } = await setup();
    const manager = await service.open(actor);
    manager.draft.access = { mode: 'everyone', roleIds: [], categories: ['auto_reply'] };
    manager.draft.autoReply.dice = false;
    await expect(service.save(manager.id, actor)).rejects.toMatchObject({ code: 'invalid' });
    manager.draft.autoReply.dice = true;
    await service.save(manager.id, actor);
    const editor = { ...actor, manager: false, userId: '500000000000000002' };
    const session = await service.open(editor);
    session.draft.autoReply.dice = false;
    await service.save(session.id, editor);
    session.draft.features.moderation_vote.enabled = true;
    await expect(service.save(session.id, editor)).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('reconciles lost acknowledgements using the persisted operation ID', async () => {
    const { service, repo } = await setup();
    const session = await service.open(actor);
    session.draft.autoReply.dice = false;
    repo.ambiguous = true;
    const result = await service.save(session.id, actor);
    expect(result.revision).toBe(1);
    expect(session.pending).toBe(false);
    expect(service.get(guildId)?.settings.autoReply.dice).toBe(false);
  });
  it('suspends runtime on unconfirmed outcomes, then reconciles without a second write', async () => {
    const { service, repo } = await setup();
    const session = await service.open(actor);
    session.draft.autoReply.dice = false;
    const write = vi.spyOn(repo, 'compareAndSwap').mockImplementationOnce(async (...args) => {
      const result = await MemoryRepo.prototype.compareAndSwap.apply(repo, args);
      repo.readsFail = true;
      return result.ok ? err(databaseError()) : result;
    });
    await expect(service.save(session.id, actor)).rejects.toMatchObject({ code: 'pending' });
    expect(service.isEnabled(guildId, 'auto_reply')).toBe(false);
    repo.readsFail = false;
    await service.getSession(session.id, actor);
    expect(service.get(guildId)?.revision).toBe(1);
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('resolves current authority before normal saves instead of trusting the panel actor', async () => {
    const repo = new MemoryRepo();
    const resolveActor = vi.fn(
      async (): Promise<GuildSettingsActor> => ({ ...actor, manager: false }),
    );
    const service = new GuildSettingsService({
      botId,
      capabilities: caps,
      repo: () => repo,
      migrationRepo: () => repo,
      legacySeed: () => defaultGuildSettings(caps),
      resolveActor,
    });
    await service.initialize([guildId]);
    const session = await service.open(actor);
    session.draft.autoReply.dice = false;
    const write = vi.spyOn(repo, 'compareAndSwap');
    await expect(service.save(session.id, actor)).rejects.toMatchObject({ code: 'forbidden' });
    expect(resolveActor).toHaveBeenCalledWith({ botId, guildId, userId: actor.userId });
    expect(write).not.toHaveBeenCalled();
    expect(session.saving).toBe(false);
  });
  it.each(['revoked', 'left'] as const)(
    'fences an unapplied write after original actor is %s',
    async (state) => {
      const { service, repo, session, original, setAuthority } = await setupPendingAuthority();
      setAuthority(state);
      const write = vi.spyOn(repo, 'compareAndSwap');
      write.mockClear();
      const result = await service.refreshGuild(guildId);
      expect(result.revision).toBe(2);
      expect(result.settings.autoReply.dice).toBe(true);
      expect(result.audit.at(-1)?.paths).toEqual([]);
      expect(result.lastOperationId).not.toBe(original[4].operationId);
      expect(session.pending).toBe(false);
      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0]?.[3].autoReply.dice).toBe(true);
      const late = await MemoryRepo.prototype.compareAndSwap.apply(repo, original);
      expect(late.ok && late.value).toBeUndefined();
      expect(repo.documents.get(`${botId}:${guildId}`)?.settings.autoReply.dice).toBe(true);
    },
  );
  it('reports forbidden to the requesting editor when cancellation succeeds', async () => {
    const { service, session, editor, setAuthority } = await setupPendingAuthority();
    setAuthority('revoked');
    await expect(service.getSession(session.id, editor)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(session.pending).toBe(false);
    expect(service.get(guildId)?.revision).toBe(2);
    expect(service.get(guildId)?.settings.autoReply.dice).toBe(true);
  });
  it('accepts an already applied original operation without asking the revoked actor again', async () => {
    const { service, repo, original, setAuthority, resolveActor } = await setupPendingAuthority();
    await MemoryRepo.prototype.compareAndSwap.apply(repo, original);
    setAuthority('left');
    resolveActor.mockClear();
    const write = vi.spyOn(repo, 'compareAndSwap');
    write.mockClear();
    expect((await service.refreshGuild(guildId)).settings.autoReply.dice).toBe(false);
    expect(resolveActor).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
  it('accepts the original when its late write wins before the cancellation fence', async () => {
    const { service, repo, session, original, setAuthority } = await setupPendingAuthority();
    setAuthority('revoked');
    const write = vi.spyOn(repo, 'compareAndSwap').mockImplementationOnce(async (...fence) => {
      await MemoryRepo.prototype.compareAndSwap.apply(repo, original);
      return MemoryRepo.prototype.compareAndSwap.apply(repo, fence);
    });
    write.mockClear();
    const result = await service.refreshGuild(guildId);
    expect(result.revision).toBe(2);
    expect(result.lastOperationId).toBe(original[4].operationId);
    expect(result.settings.autoReply.dice).toBe(false);
    expect(session.pending).toBe(false);
    expect(write.mock.calls[0]?.[4].paths).toEqual([]);
  });
  it('recognizes a cancellation fence after an unknown acknowledgement and read failure', async () => {
    const { service, repo, session, setAuthority } = await setupPendingAuthority();
    setAuthority('left');
    const write = vi.spyOn(repo, 'compareAndSwap').mockImplementationOnce(async (...fence) => {
      await MemoryRepo.prototype.compareAndSwap.apply(repo, fence);
      repo.readsFail = true;
      return err(databaseError());
    });
    write.mockClear();
    await expect(service.refreshGuild(guildId)).rejects.toMatchObject({ code: 'pending' });
    expect(session.cancellationOperationId).toBeDefined();
    expect(service.get(guildId)).toBeUndefined();
    repo.readsFail = false;
    const recovered = await service.refreshGuild(guildId);
    expect(recovered.revision).toBe(2);
    expect(recovered.settings.autoReply.dice).toBe(true);
    expect(session.pending).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('keeps the operation pending during transient membership failures', async () => {
    const { service, repo, session, original, setAuthority } = await setupPendingAuthority();
    setAuthority('network');
    const write = vi.spyOn(repo, 'compareAndSwap');
    write.mockClear();
    await expect(service.refreshGuild(guildId)).rejects.toMatchObject({ code: 'pending' });
    expect(session.pending).toBe(true);
    expect(session.cancellationOperationId).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
    setAuthority('active');
    const recovered = await service.refreshGuild(guildId);
    expect(recovered.lastOperationId).toBe(original[4].operationId);
    expect(recovered.settings.autoReply.dice).toBe(false);
  });
  it('fences resource permission denial and rejects a substituted resolver identity', async () => {
    for (const scenario of ['resources', 'identity'] as const) {
      const { service, repo, session, setAuthority, denyResources } = await setupPendingAuthority();
      if (scenario === 'resources') denyResources();
      else setAuthority('spoof');
      const write = vi.spyOn(repo, 'compareAndSwap');
      write.mockClear();
      const recovered = await service.refreshGuild(guildId);
      expect(recovered.settings.autoReply.dice).toBe(true);
      expect(recovered.audit.at(-1)?.paths).toEqual([]);
      expect(write).toHaveBeenCalledTimes(1);
      expect(session.pending).toBe(false);
    }
  });
  it('refreshes a failed settings load automatically without opening a panel', async () => {
    const { service, repo } = await setup();
    repo.readsFail = true;
    await expect(service.refreshGuild(guildId)).rejects.toMatchObject({ code: 'unavailable' });
    expect(service.get(guildId)).toBeUndefined();
    repo.readsFail = false;
    expect((await service.refreshGuild(guildId)).revision).toBe(0);
    expect(service.isEnabled(guildId, 'auto_reply')).toBe(true);
  });
  it('reconciles an uncertain write through background refresh without opening a panel', async () => {
    const { service, repo } = await setup();
    const session = await service.open(actor);
    session.draft.autoReply.dice = false;
    const write = vi.spyOn(repo, 'compareAndSwap').mockImplementationOnce(async (...args) => {
      await MemoryRepo.prototype.compareAndSwap.apply(repo, args);
      repo.readsFail = true;
      return err(databaseError());
    });
    await expect(service.save(session.id, actor)).rejects.toMatchObject({ code: 'pending' });
    expect(service.get(guildId)).toBeUndefined();
    repo.readsFail = false;
    expect((await service.refreshGuild(guildId)).revision).toBe(1);
    expect(service.get(guildId)?.settings.autoReply.dice).toBe(false);
    expect(session.pending).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('shares pending recovery across background refresh and concurrent panel access', async () => {
    const { service, repo } = await setup();
    const session = await service.open(actor);
    session.draft.autoReply.dice = false;
    vi.spyOn(repo, 'compareAndSwap').mockImplementationOnce(async () => {
      repo.readsFail = true;
      return err(databaseError());
    });
    await expect(service.save(session.id, actor)).rejects.toMatchObject({ code: 'pending' });
    repo.readsFail = false;
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = vi.spyOn(repo, 'compareAndSwap').mockImplementationOnce(async (...args) => {
      entered();
      await delayed;
      return MemoryRepo.prototype.compareAndSwap.apply(repo, args);
    });
    const refreshing = service.refreshGuild(guildId);
    await started;
    const panel = service.open(actor);
    const existing = service.getSession(session.id, actor);
    const anotherRefresh = service.refreshGuild(guildId);
    release();
    const [snapshot, opened, previous, again] = await Promise.all([
      refreshing,
      panel,
      existing,
      anotherRefresh,
    ]);
    expect(snapshot.revision).toBe(1);
    expect(again.revision).toBe(1);
    expect(opened.baseRevision).toBe(1);
    expect(previous.pending).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('reissues the same operation when the original write can commit after an old readback', async () => {
    const { service, repo } = await setup();
    const session = await service.open(actor);
    session.draft.autoReply.dice = false;
    let original: Parameters<MemoryRepo['compareAndSwap']> | undefined;
    const write = vi.spyOn(repo, 'compareAndSwap').mockImplementationOnce(async (...args) => {
      original = args;
      return err(databaseError());
    });
    const saved = await service.save(session.id, actor);
    expect(saved.revision).toBe(1);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0]?.[4].operationId).toBe(write.mock.calls[1]?.[4].operationId);
    expect((await MemoryRepo.prototype.compareAndSwap.apply(repo, original!)).ok).toBe(true);
    expect(repo.documents.get(`${botId}:${guildId}`)?.revision).toBe(1);
  });
  it('resets save locks after a thrown repository resolver and permits retry', async () => {
    const repo = new MemoryRepo();
    let calls = 0;
    const service = new GuildSettingsService({
      botId,
      capabilities: caps,
      migrationRepo: () => repo,
      repo: () => {
        calls++;
        if (calls === 4) throw new Error('Resolver offline');
        return repo;
      },
      legacySeed: () => defaultGuildSettings(caps),
    });
    await service.initialize([guildId]);
    const session = await service.open(actor);
    session.draft.autoReply.dice = false;
    await expect(service.save(session.id, actor)).rejects.toThrow('Resolver offline');
    expect(session.saving).toBe(false);
    expect(session.pending).toBe(false);
    expect((await service.save(session.id, actor)).revision).toBe(1);
  });
  it('locks a session while resources are validated and prevents concurrent mutations', async () => {
    const repo = new MemoryRepo();
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const validation = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new GuildSettingsService({
      botId,
      capabilities: caps,
      migrationRepo: () => repo,
      repo: () => repo,
      legacySeed: () => defaultGuildSettings(caps),
      validateResources: async () => {
        entered();
        await validation;
      },
    });
    await service.initialize([guildId]);
    const session = await service.open(actor);
    session.draft.autoReply.dice = false;
    const saving = service.save(session.id, actor);
    await started;
    await expect(service.save(session.id, actor)).rejects.toMatchObject({ code: 'pending' });
    await expect(service.stage(session.id, actor, session.draft)).rejects.toMatchObject({
      code: 'pending',
    });
    release();
    expect((await saving).revision).toBe(1);
  });
  it('clamps effective values after operator capability changes without blocking unrelated edits', async () => {
    const { repo, service } = await setup();
    const session = await service.open(actor);
    session.draft.autoReply.probability = 0.05;
    session.draft.socialPreview.maxUrlsPerMessage = 5;
    session.draft.features.social_preview.enabled = true;
    await service.save(session.id, actor);
    const reduced = {
      ...caps,
      features: { ...caps.features, social_preview: false },
      socialProviders: ['x'],
      maxPreviewUrls: 1,
      maxRandomProbability: 0.01,
      minCooldownSeconds: 10,
    };
    const restarted = new GuildSettingsService({
      botId,
      capabilities: reduced,
      repo: () => repo,
      migrationRepo: () => repo,
      legacySeed: () => defaultGuildSettings(reduced),
    });
    await restarted.initialize([guildId]);
    expect(restarted.get(guildId)?.settings.socialPreview.providers).toEqual(['x']);
    expect(restarted.get(guildId)?.settings.autoReply.probability).toBe(0.01);
    expect(restarted.get(guildId)?.settings.autoReply.cooldownSeconds).toBe(10);
    expect(restarted.get(guildId)?.settings.socialPreview.maxUrlsPerMessage).toBe(1);
    expect(restarted.isEnabled(guildId, 'social_preview')).toBe(false);
    const editing = await restarted.open(actor);
    expect(editing.draft.socialPreview.maxUrlsPerMessage).toBe(5);
    editing.draft.autoReply.dice = false;
    await restarted.save(editing.id, actor);
    expect(restarted.get(guildId)?.revision).toBe(2);
  });
  it('rejects unknown fields, invalid resource IDs, and capability escalation', async () => {
    const { service } = await setup();
    const session = await service.open(actor);
    const invalid = cloneSettings(session.draft);
    invalid.autoReply.probability = 0.8;
    await expect(service.stage(session.id, actor, invalid)).rejects.toMatchObject({
      code: 'invalid',
    });
    invalid.autoReply.probability = 0;
    invalid.features.auto_reply.channelIds = ['foreign'];
    await expect(service.stage(session.id, actor, invalid)).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(
      service.stage(session.id, actor, { ...session.draft, secret: true } as GuildSettings),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
  it('inherits exclusions through ancestors and lets exclusions override allowlists', async () => {
    const { service } = await setup();
    const session = await service.open(actor);
    session.draft.features.auto_reply = {
      enabled: true,
      mode: 'allowlist',
      channelIds: [channelId],
      excludedChannelIds: [roleId],
    };
    await service.save(session.id, actor);
    expect(service.isEnabled(guildId, 'auto_reply', '400000000000000002', [channelId])).toBe(true);
    expect(service.isEnabled(guildId, 'auto_reply', channelId, [roleId])).toBe(false);
    expect(service.isEnabled(guildId, 'auto_reply')).toBe(false);
  });
  it('rejects component messages before the command response is bound', async () => {
    const { service, repo } = await setup();
    const session = await service.open(actor);
    const reads = vi.spyOn(repo, 'find');
    await expect(
      service.getSession(session.id, { ...actor, messageId: channelId }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(() => service.beginModal(session.id, { ...actor, messageId: channelId })).toThrow();
    expect(reads).not.toHaveBeenCalled();
    await service.bindMessage(session.id, actor, channelId);
    await expect(
      service.getSession(session.id, { ...actor, messageId: channelId }),
    ).resolves.toMatchObject({ messageId: channelId });
  });
  it('begins a modal synchronously without database reads and checks fresh role authority', async () => {
    const { service, repo } = await setup();
    const manager = await service.open(actor);
    manager.draft.access = { mode: 'roles', roleIds: [roleId], categories: ['auto_reply'] };
    await service.save(manager.id, actor);
    const editor = { ...actor, manager: false, userId: '500000000000000002', roleIds: [roleId] };
    const session = await service.open(editor);
    await service.bindMessage(session.id, editor, channelId);
    const bound = { ...editor, messageId: channelId };
    const reads = vi.spyOn(repo, 'find');
    const modal = service.beginModal(session.id, bound);
    expect(modal.session.id).toBe(session.id);
    expect(modal.nonce).toBe(session.modalNonce);
    expect(reads).not.toHaveBeenCalled();
    expect(() => service.beginModal(session.id, { ...bound, userId: actor.userId })).toThrow();
    expect(() => service.beginModal(session.id, { ...bound, roleIds: [] })).toThrow();
    expect(reads).not.toHaveBeenCalled();
  });
  it('binds a modal nonce to its exact feature and rejects replay after context substitution', async () => {
    const { service } = await setup();
    const session = await service.open(actor);
    const { nonce } = service.beginModal(session.id, actor, 'scope_auto_reply');
    await expect(
      service.consumeModalNonce(session.id, actor, nonce, 'scope_moderation_vote'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      service.consumeModalNonce(session.id, actor, nonce, 'scope_auto_reply'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const entertainment = service.beginModal(session.id, actor, 'entertainment_gay');
    await expect(
      service.consumeModalNonce(session.id, actor, entertainment.nonce, 'entertainment_gay'),
    ).resolves.toMatchObject({ id: session.id });
    await expect(
      service.consumeModalNonce(session.id, actor, entertainment.nonce, 'entertainment_gay'),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('binds one-use modal nonces to their owner and panel message', async () => {
    const { service } = await setup();
    const session = await service.open(actor);
    await service.bindMessage(session.id, actor, channelId);
    const bound = { ...actor, messageId: channelId };
    const nonce = await service.createModalNonce(session.id, bound);
    await expect(
      service.consumeModalNonce(session.id, { ...bound, userId: '500000000000000002' }, nonce),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await service.consumeModalNonce(session.id, bound, nonce);
    await expect(service.consumeModalNonce(session.id, bound, nonce)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
  it('expires sessions absolutely, bounds capacity and invalidates guild drafts', async () => {
    let now = 0;
    const { service } = await setup(new MemoryRepo(), [guildId], () => now);
    const session = await service.open(actor);
    now = 600000;
    await expect(service.getSession(session.id, actor)).rejects.toMatchObject({ code: 'expired' });
    const sessions = new GuildSettingsSessions(() => 0, 1);
    sessions.open(actor, service.get(guildId)!);
    expect(() =>
      sessions.open({ ...actor, userId: '500000000000000002' }, service.get(guildId)!),
    ).toThrow();
    const active = await service.open(actor);
    service.forgetGuild(guildId);
    await expect(service.getSession(active.id, actor)).rejects.toMatchObject({ code: 'expired' });
  });
});

describe('earthquake settings policy', () => {
  const available: OperatorCapabilities = { ...caps, earthquake: { alerts: true, reports: true } };
  it('requires a destination, permits no role, and saves both switches independently', async () => {
    const { service } = await setup(new MemoryRepo(), [guildId], undefined, available);
    const session = await service.open(actor);
    const draft = cloneSettings(session.draft);
    draft.earthquake.alertsEnabled = true;
    await expect(service.stage(session.id, actor, draft)).rejects.toMatchObject({
      code: 'invalid',
    });
    draft.earthquake.channelId = channelId;
    await service.stage(session.id, actor, draft);
    await service.save(session.id, actor);
    expect(service.get(guildId)?.settings.earthquake).toEqual({
      alertsEnabled: true,
      reportsEnabled: false,
      channelId,
      roleId: null,
    });
  });
  it('rejects unavailable feeds and delegated edits to earthquake preferences', async () => {
    const { service } = await setup();
    const session = await service.open(actor);
    const draft = cloneSettings(session.draft);
    draft.earthquake = { alertsEnabled: true, reportsEnabled: false, channelId, roleId: null };
    await expect(service.stage(session.id, actor, draft)).rejects.toMatchObject({
      code: 'invalid',
    });
    const repo = new MemoryRepo();
    const settings = defaultGuildSettings(available);
    settings.access = { mode: 'everyone', roleIds: [], categories: ['auto_reply'] };
    await repo.seed({ botId, guildId, settings, revision: 0, audit: [], lastOperationId: 'seed' });
    const delegated = await setup(repo, [guildId], undefined, available);
    const editor = { ...actor, manager: false };
    const edit = await delegated.service.open(editor);
    const modified = cloneSettings(edit.draft);
    modified.earthquake.channelId = channelId;
    await expect(delegated.service.stage(edit.id, editor, modified)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
  it('clamps stored switches when upstream capabilities disappear without rewriting preferences', async () => {
    const repo = new MemoryRepo();
    const settings = defaultGuildSettings(available);
    settings.earthquake = { alertsEnabled: true, reportsEnabled: true, channelId, roleId };
    await repo.seed({ botId, guildId, settings, revision: 0, audit: [], lastOperationId: 'seed' });
    const { service } = await setup(repo);
    expect(service.get(guildId)?.settings.earthquake).toEqual({
      alertsEnabled: false,
      reportsEnabled: false,
      channelId,
      roleId,
    });
    expect(await repo.find(botId, guildId)).toMatchObject({
      ok: true,
      value: { settings: { earthquake: { alertsEnabled: true, reportsEnabled: true } } },
    });
  });
});
