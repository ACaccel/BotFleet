import { randomBytes } from 'node:crypto';
import {
  FEATURES,
  normalizeGuildSettings,
  changedSettingsPaths,
  cloneSettings,
  defaultGuildSettings,
  GuildSettingsError,
  immutableSnapshot,
  type GuildFeature,
  type GuildSettings,
  type GuildSettingsActor,
  type GuildSettingsRuntime,
  type GuildSettingsSnapshot,
  type OperatorCapabilities,
} from '../../core/guild-settings';
import type { GuildSettingsRepo } from '../../persistence/repositories/guild-settings.repo';
import { assertSettingsAuthority, canOpenSettings } from './authority';
import { GuildSettingsSessions, type GuildSettingsSession } from './session';
import { validateSettings } from './validation';

export type GuildSettingsActorIdentity = Pick<GuildSettingsActor, 'botId' | 'guildId' | 'userId'>;

export interface GuildSettingsServiceOptions {
  readonly resolveActor?: (identity: GuildSettingsActorIdentity) => Promise<GuildSettingsActor>;
  readonly botId: string;
  readonly repo: (guildId: string) => GuildSettingsRepo | Promise<GuildSettingsRepo>;
  readonly migrationRepo: () => GuildSettingsRepo | Promise<GuildSettingsRepo>;
  readonly capabilities: OperatorCapabilities;
  readonly legacySeed: (guildId: string) => GuildSettings | Promise<GuildSettings>;
  readonly validateResources?: (
    settings: GuildSettings,
    actor: GuildSettingsActor,
    committed: GuildSettings,
  ) => Promise<void>;
  readonly now?: () => number;
}
export class GuildSettingsService implements GuildSettingsRuntime {
  public readonly capabilities: OperatorCapabilities;
  private readonly snapshots = new Map<string, GuildSettingsSnapshot>();
  private readonly effectiveSnapshots = new Map<string, GuildSettingsSnapshot>();
  private readonly sessions: GuildSettingsSessions;
  private readonly now: () => number;
  private migrationGuildIds: ReadonlySet<string> | undefined;
  private initialization: Promise<void> | undefined;
  private readonly pendingGuilds = new Set<string>();
  private readonly pendingWrites = new Map<string, GuildSettingsSession>();
  private readonly recoveries = new Map<string, Promise<GuildSettingsSnapshot>>();
  constructor(private readonly options: GuildSettingsServiceOptions) {
    this.capabilities = options.capabilities;
    this.now = options.now ?? Date.now;
    this.sessions = new GuildSettingsSessions(this.now);
  }
  get initialized(): boolean {
    return this.migrationGuildIds !== undefined;
  }
  initialize(guildIds: readonly string[]): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = this.initializeInventory(guildIds).finally(() => {
      this.initialization = undefined;
    });
    return this.initialization;
  }
  private async initializeInventory(guildIds: readonly string[]): Promise<void> {
    const repo = await this.options.migrationRepo();
    const inventory = await repo.fixMigration(this.options.botId, guildIds);
    if (!inventory.ok) throw new GuildSettingsError('unavailable');
    this.migrationGuildIds = new Set(inventory.value.guildIds);
    const hydration = await Promise.allSettled(
      guildIds.map((guildId) => this.hydrateGuild(guildId)),
    );
    let failures = 0;
    hydration.forEach((result, index) => {
      if (result.status === 'rejected') {
        failures++;
        const guildId = guildIds[index];
        if (guildId !== undefined) {
          this.snapshots.delete(guildId);
          this.effectiveSnapshots.delete(guildId);
        }
      }
    });
    if (failures > 0)
      throw new GuildSettingsError('unavailable', `${failures} guild settings failed to load`);
  }
  async ensureGuild(guildId: string): Promise<GuildSettingsSnapshot> {
    if (this.initialization) await this.initialization;
    if (!this.migrationGuildIds)
      throw new GuildSettingsError('unavailable', 'Settings inventory is not initialized');
    return this.hydrateGuild(guildId);
  }
  async refreshGuild(guildId: string): Promise<GuildSettingsSnapshot> {
    if (this.initialization) await this.initialization;
    if (!this.migrationGuildIds)
      throw new GuildSettingsError('unavailable', 'Settings inventory is not initialized');
    if (!this.pendingGuilds.has(guildId)) return this.hydrateGuild(guildId);
    try {
      return await this.recoverPendingGuild(guildId);
    } catch (error: unknown) {
      if (!(error instanceof GuildSettingsError && ['conflict', 'forbidden'].includes(error.code)))
        throw error;
      const snapshot = this.snapshots.get(guildId);
      if (!snapshot) throw new GuildSettingsError('unavailable');
      return snapshot;
    }
  }
  private async hydrateGuild(guildId: string): Promise<GuildSettingsSnapshot> {
    const repo = await this.options.repo(guildId);
    const result = await repo.find(this.options.botId, guildId);
    if (!result.ok) {
      this.snapshots.delete(guildId);
      this.effectiveSnapshots.delete(guildId);
      throw new GuildSettingsError('unavailable');
    }
    if (result.value) return this.publish(result.value);
    const defaults = this.migrationGuildIds?.has(guildId)
      ? await this.options.legacySeed(guildId)
      : defaultGuildSettings(this.capabilities);
    const settings = validateSettings(defaults, this.capabilities);
    const seeded = await repo.seed({
      botId: this.options.botId,
      guildId,
      revision: 0,
      settings,
      audit: [],
      lastOperationId: 'seed',
    });
    if (!seeded.ok) throw new GuildSettingsError('unavailable');
    return this.publish(seeded.value);
  }
  get(guildId: string): GuildSettingsSnapshot | undefined {
    return this.pendingGuilds.has(guildId) ? undefined : this.effectiveSnapshots.get(guildId);
  }
  isEnabled(
    guildId: string,
    feature: GuildFeature,
    channelId?: string,
    ancestors: readonly string[] = [],
  ): boolean {
    const snapshot = this.get(guildId);
    if (!snapshot || !this.capabilities.features[feature]) return false;
    const settings = snapshot.settings.features[feature];
    if (!settings.enabled) return false;
    const scope = channelId === undefined ? ancestors : [channelId, ...ancestors];
    if (scope.some((id) => settings.excludedChannelIds.includes(id))) return false;
    return settings.mode === 'all' || scope.some((id) => settings.channelIds.includes(id));
  }
  async open(actor: GuildSettingsActor): Promise<GuildSettingsSession> {
    this.assertBot(actor);
    const snapshot = await this.refreshGuild(actor.guildId);
    if (!canOpenSettings(actor, snapshot.settings)) throw new GuildSettingsError('forbidden');
    return this.sessions.open(actor, snapshot);
  }
  async getSession(id: string, actor: GuildSettingsActor): Promise<GuildSettingsSession> {
    this.assertBot(actor);
    const session = this.sessions.get(id, actor);
    if (session.saving && !this.recoveries.has(actor.guildId))
      throw new GuildSettingsError('pending');
    const snapshot = await this.ensureGuild(actor.guildId);
    if (session.saving && !this.recoveries.has(actor.guildId))
      throw new GuildSettingsError('pending');
    if (!canOpenSettings(actor, snapshot.settings)) throw new GuildSettingsError('forbidden');
    if (session.pending) await this.recoverPendingGuild(actor.guildId);
    return session;
  }
  async bindMessage(id: string, actor: GuildSettingsActor, messageId: string): Promise<void> {
    const session = await this.getSession(id, actor);
    if (session.messageId !== undefined && session.messageId !== messageId)
      throw new GuildSettingsError('forbidden');
    session.messageId = messageId;
  }
  beginModal(
    id: string,
    actor: GuildSettingsActor,
    context?: string,
  ): { session: GuildSettingsSession; nonce: string } {
    this.assertBot(actor);
    const session = this.sessions.get(id, actor);
    const committed = this.snapshots.get(actor.guildId);
    if (!this.initialized || !committed) throw new GuildSettingsError('unavailable');
    if (session.saving || session.pending || this.pendingGuilds.has(actor.guildId))
      throw new GuildSettingsError('pending');
    if (!canOpenSettings(actor, committed.settings)) throw new GuildSettingsError('forbidden');
    session.modalNonce = randomBytes(12).toString('base64url');
    session.modalContext = context;
    return { session, nonce: session.modalNonce };
  }
  async createModalNonce(id: string, actor: GuildSettingsActor): Promise<string> {
    await this.getSession(id, actor);
    return this.beginModal(id, actor).nonce;
  }
  async consumeModalNonce(
    id: string,
    actor: GuildSettingsActor,
    nonce: string,
    context?: string,
  ): Promise<GuildSettingsSession> {
    const session = await this.getSession(id, actor);
    if (session.modalNonce === undefined || session.modalNonce !== nonce)
      throw new GuildSettingsError('forbidden');
    const expectedContext = session.modalContext;
    delete session.modalNonce;
    delete session.modalContext;
    if (expectedContext !== context) throw new GuildSettingsError('forbidden');
    return session;
  }
  async stage(
    id: string,
    actor: GuildSettingsActor,
    settings: GuildSettings,
  ): Promise<GuildSettingsSession> {
    const session = await this.getSession(id, actor);
    if (session.pending) throw new GuildSettingsError('pending');
    const snapshot = this.snapshots.get(actor.guildId);
    if (!snapshot) throw new GuildSettingsError('unavailable');
    const validated = validateSettings(settings, this.capabilities, actor, snapshot.settings, {
      allowIncompleteAccess: actor.manager,
    });
    assertSettingsAuthority(
      actor,
      snapshot.settings,
      changedSettingsPaths(session.base, validated),
      validated,
    );
    session.draft = cloneSettings(validated);
    return session;
  }
  async save(id: string, actor: GuildSettingsActor): Promise<GuildSettingsSnapshot> {
    const session = await this.getSession(id, actor);
    if (session.pending) throw new GuildSettingsError('pending');
    if (this.pendingGuilds.has(actor.guildId)) await this.recoverPendingGuild(actor.guildId);
    const committed = this.snapshots.get(actor.guildId);
    if (!committed) throw new GuildSettingsError('unavailable');
    if (committed.revision !== session.baseRevision) throw new GuildSettingsError('conflict');
    const settings = validateSettings(session.draft, this.capabilities, actor, committed.settings);
    const paths = changedSettingsPaths(session.base, settings);
    if (session.pending || session.saving) throw new GuildSettingsError('pending');
    session.saving = true;
    let repo: GuildSettingsRepo;
    let resolvedActor: GuildSettingsActor;
    try {
      resolvedActor = await this.resolveFreshActor(actor);
      assertSettingsAuthority(resolvedActor, committed.settings, paths, settings);
      if (paths.length === 0) {
        session.saving = false;
        return committed;
      }
      await this.options.validateResources?.(settings, resolvedActor, committed.settings);
      repo = await this.options.repo(actor.guildId);
    } catch (error: unknown) {
      session.saving = false;
      throw error;
    }
    session.pending = true;
    session.pendingSettings = immutableSnapshot({ ...committed, settings }).settings;
    session.pendingActor = { ...resolvedActor, roleIds: [...resolvedActor.roleIds] };
    session.operationId = randomBytes(18).toString('base64url');
    try {
      const result = await this.writeDraft(repo, session, actor.userId);
      if (result.ok && result.value) {
        const snapshot = this.publish(result.value);
        this.accept(session, snapshot);
        return snapshot;
      }
      if (result.ok) {
        this.clearIntent(session);
        await this.ensureGuild(actor.guildId);
        throw new GuildSettingsError('conflict');
      }
    } catch (error: unknown) {
      if (error instanceof GuildSettingsError && error.code === 'conflict') throw error;
    } finally {
      session.saving = false;
    }
    this.pendingGuilds.add(actor.guildId);
    this.pendingWrites.set(actor.guildId, session);
    return this.recoverPendingGuild(actor.guildId);
  }

  async discard(id: string, actor: GuildSettingsActor): Promise<GuildSettingsSession> {
    const session = await this.getSession(id, actor);
    if (session.pending) throw new GuildSettingsError('pending');
    const snapshot = this.snapshots.get(actor.guildId);
    if (!snapshot) throw new GuildSettingsError('unavailable');
    this.accept(session, snapshot);
    return session;
  }
  close(id: string): void {
    this.sessions.close(id);
  }
  forgetGuild(guildId: string): void {
    this.snapshots.delete(guildId);
    this.effectiveSnapshots.delete(guildId);
    this.pendingGuilds.delete(guildId);
    this.pendingWrites.delete(guildId);
    this.sessions.forgetGuild(guildId);
  }
  private assertBot(actor: GuildSettingsActor): void {
    if (actor.botId !== this.options.botId) throw new GuildSettingsError('forbidden');
  }
  private publish(snapshot: GuildSettingsSnapshot): GuildSettingsSnapshot {
    const current = this.snapshots.get(snapshot.guildId);
    if (current && current.revision > snapshot.revision) return current;
    const immutable = immutableSnapshot({
      ...snapshot,
      settings: normalizeGuildSettings(snapshot.settings),
    });
    this.snapshots.set(snapshot.guildId, immutable);
    const effective = cloneSettings(immutable.settings);
    effective.earthquake.alertsEnabled &&= this.capabilities.earthquake?.alerts ?? false;
    effective.earthquake.reportsEnabled &&= this.capabilities.earthquake?.reports ?? false;
    for (const feature of FEATURES)
      effective.features[feature].enabled &&= this.capabilities.features[feature];
    effective.socialPreview.providers = effective.socialPreview.providers.filter((provider) =>
      this.capabilities.socialProviders.includes(provider),
    );
    effective.socialPreview.maxUrlsPerMessage = Math.min(
      effective.socialPreview.maxUrlsPerMessage,
      this.capabilities.maxPreviewUrls,
    );
    effective.autoReply.probability = Math.min(
      effective.autoReply.probability,
      this.capabilities.maxRandomProbability,
    );
    effective.autoReply.cooldownSeconds = Math.max(
      effective.autoReply.cooldownSeconds,
      this.capabilities.minCooldownSeconds,
    );
    this.effectiveSnapshots.set(
      snapshot.guildId,
      immutableSnapshot({ ...snapshot, settings: effective }),
    );
    return immutable;
  }
  private accept(session: GuildSettingsSession, snapshot: GuildSettingsSnapshot): void {
    session.baseRevision = snapshot.revision;
    session.base = cloneSettings(snapshot.settings);
    session.draft = cloneSettings(snapshot.settings);
    this.clearIntent(session);
  }
  private recoverPendingGuild(guildId: string): Promise<GuildSettingsSnapshot> {
    const running = this.recoveries.get(guildId);
    if (running) return running;
    const recovery = this.performRecovery(guildId).finally(() => {
      if (this.recoveries.get(guildId) === recovery) this.recoveries.delete(guildId);
    });
    this.recoveries.set(guildId, recovery);
    return recovery;
  }
  private async performRecovery(guildId: string): Promise<GuildSettingsSnapshot> {
    const session = this.pendingWrites.get(guildId);
    if (!session || session.saving) throw new GuildSettingsError('pending');
    const repo = await this.options.repo(guildId);
    const snapshot = await this.readOutcome(repo, guildId);
    if (!snapshot) throw new GuildSettingsError('pending');
    return this.reconcile(session, this.publish(snapshot), repo);
  }
  private async writeDraft(repo: GuildSettingsRepo, session: GuildSettingsSession, userId: string) {
    if (!session.operationId || !session.pendingSettings) throw new GuildSettingsError('pending');
    return repo.compareAndSwap(
      this.options.botId,
      session.guildId,
      session.baseRevision,
      session.pendingSettings,
      {
        operationId: session.operationId,
        revision: session.baseRevision + 1,
        userId,
        at: this.now(),
        paths: changedSettingsPaths(session.base, session.pendingSettings),
      },
    );
  }
  private async readOutcome(
    repo: GuildSettingsRepo,
    guildId: string,
  ): Promise<GuildSettingsSnapshot | undefined> {
    try {
      const result = await repo.find(this.options.botId, guildId);
      return result.ok ? result.value : undefined;
    } catch {
      return undefined;
    }
  }
  private async resolveFreshActor(actor: GuildSettingsActor): Promise<GuildSettingsActor> {
    const resolved = this.options.resolveActor
      ? await this.options.resolveActor({
          botId: actor.botId,
          guildId: actor.guildId,
          userId: actor.userId,
        })
      : actor;
    if (
      resolved.botId !== actor.botId ||
      resolved.guildId !== actor.guildId ||
      resolved.userId !== actor.userId
    ) {
      throw new GuildSettingsError('forbidden');
    }
    return resolved;
  }
  private clearIntent(session: GuildSettingsSession): void {
    session.pending = false;
    delete session.operationId;
    delete session.pendingSettings;
    delete session.pendingActor;
    delete session.cancellationOperationId;
    this.pendingGuilds.delete(session.guildId);
    this.pendingWrites.delete(session.guildId);
  }
  private async reconcile(
    session: GuildSettingsSession,
    snapshot: GuildSettingsSnapshot,
    repo: GuildSettingsRepo,
  ): Promise<GuildSettingsSnapshot> {
    const contains = (current: GuildSettingsSnapshot, operationId: string | undefined): boolean =>
      operationId !== undefined &&
      (current.lastOperationId === operationId ||
        current.audit.some((entry) => entry.operationId === operationId));
    let current = snapshot;
    const finish = (): GuildSettingsSnapshot | undefined => {
      if (contains(current, session.operationId)) {
        this.accept(session, current);
        return current;
      }
      if (contains(current, session.cancellationOperationId)) {
        this.accept(session, current);
        throw new GuildSettingsError('forbidden');
      }
      if (current.revision !== session.baseRevision) {
        this.clearIntent(session);
        throw new GuildSettingsError('conflict');
      }
      return undefined;
    };
    const completed = finish();
    if (completed) return completed;
    session.saving = true;
    try {
      if (!session.cancellationOperationId) {
        try {
          if (!session.pendingActor || !session.pendingSettings)
            throw new GuildSettingsError('pending');
          const actor = await this.resolveFreshActor(session.pendingActor);
          const settings = validateSettings(
            session.pendingSettings,
            this.capabilities,
            actor,
            current.settings,
          );
          assertSettingsAuthority(
            actor,
            current.settings,
            changedSettingsPaths(session.base, settings),
            settings,
          );
          await this.options.validateResources?.(settings, actor, current.settings);
        } catch (error: unknown) {
          if (
            error instanceof GuildSettingsError &&
            ['forbidden', 'invalid'].includes(error.code)
          ) {
            session.cancellationOperationId = randomBytes(18).toString('base64url');
          } else throw new GuildSettingsError('pending');
        }
      }
      try {
        const result = session.cancellationOperationId
          ? await repo.compareAndSwap(
              this.options.botId,
              session.guildId,
              session.baseRevision,
              current.settings,
              {
                operationId: session.cancellationOperationId,
                revision: session.baseRevision + 1,
                userId: session.userId,
                at: this.now(),
                paths: [],
              },
            )
          : await this.writeDraft(repo, session, session.userId);
        if (result.ok && result.value) current = this.publish(result.value);
        else {
          const readback = await this.readOutcome(repo, session.guildId);
          if (readback) current = this.publish(readback);
        }
      } catch {
        const readback = await this.readOutcome(repo, session.guildId);
        if (readback) current = this.publish(readback);
      }
    } finally {
      session.saving = false;
    }
    const result = finish();
    if (result) return result;
    this.pendingGuilds.add(session.guildId);
    throw new GuildSettingsError('pending');
  }
}
