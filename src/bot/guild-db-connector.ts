/**
 * Owns per-guild MongoDB connection lifecycle on behalf of BaseBot.
 *
 * Single responsibility: orchestrate the per-guild fan-out that opens
 * each guild's connection through {@link ReposFactory} and surfaces the
 * shared {@link ConnectionManager}'s `traceId` on the boot log so
 * support can correlate the user-facing `errors:db.guild_disabled`
 * message back to the structured log line.
 *
 * The shared {@link ConnectionManager} (resolved via the IoC container)
 * still owns the actual classification + disabling logic; this class
 * is a thin orchestration layer. It is one of the three
 * collaborators BaseBot composes; it is intentionally NOT registered
 * as an IoC token (no plugin needs to reach it).
 */
import { isTransient } from '../persistence/error-translator';
import type { ServiceContainer } from '../core/ioc';
import { asGuildId } from '../core/ids';
import { logSystem, ops, type Logger } from '../core/logger';
import type { ConnectionManager, DisabledGuildState } from '../infra/mongo/connection-manager';

import type { GuildInfo } from './index';
import { TOKENS, type ReposFactory } from './tokens';
import type { Repos } from '../persistence/repositories';

/**
 * Callback BaseBot passes into {@link GuildDbConnector.connectAll} so the
 * connector can publish each freshly-built {@link Repos} bag back into
 * BaseBot's private guild map. Keeps mutation private to BaseBot — the
 * connector never holds a reference to the map itself.
 */
type AttachReposFn = (guildId: string, repos: Repos) => void;

export class GuildDbConnector {
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryGeneration = 0;

  /** Retry missing repositories without overlapping passes or replaying healthy guild hooks. */
  public startRecovery(
    guildInfo: ReadonlyMap<string, GuildInfo>,
    attachRepos: AttachReposFn,
    onRecovered: (guildId: string) => Promise<void>,
    intervalMs: number,
  ): void {
    this.stopRecovery();
    if (!this.mongoURI) return;
    const generation = this.recoveryGeneration;
    const schedule = (): void => {
      if (generation !== this.recoveryGeneration) return;
      this.recoveryTimer = setTimeout(() => {
        void recover();
      }, intervalMs);
      this.recoveryTimer.unref();
    };
    const recover = async (): Promise<void> => {
      try {
        for (const [guildId, slot] of guildInfo) {
          if (generation !== this.recoveryGeneration) return;
          if (slot.repos !== undefined) continue;
          const disabled = this.isDisabled(guildId);
          if (disabled !== undefined && !isTransient(disabled.error)) continue;
          try {
            const repos = await this.connectOne(guildId);
            if (generation !== this.recoveryGeneration) return;
            if (repos === undefined || !guildInfo.has(guildId)) continue;
            attachRepos(guildId, repos);
            await onRecovered(guildId);
            this.logger.info({ guildId }, 'guild database recovered');
          } catch (err: unknown) {
            this.logger.warn({ guildId, err }, 'guild database recovery failed');
          }
        }
      } finally {
        schedule();
      }
    };
    schedule();
  }

  /** In-flight opens may settle, but cannot publish repos or restart the timer. */
  public stopRecovery(): void {
    this.recoveryGeneration += 1;
    if (this.recoveryTimer !== undefined) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }

  /**
   * @param container - the bot's IoC container; resolved per call so
   *   a future hot-swap of `TOKENS.ReposFactory` is observable.
   * @param mongoURI - the bot's Mongo base URI; `undefined` or empty
   *   means the bot was built without a database — `connectAll`
   *   short-circuits, mirroring the prior BaseBot behaviour.
   * @param logger - structured logger for ops visibility. The injected
   *   logger already carries `{ bot: <clientId> }` in its base bindings,
   *   so every line stays grep-able by bot without an explicit param.
   */
  public constructor(
    private readonly container: ServiceContainer,
    private readonly mongoURI: string | undefined,
    private readonly logger: Logger,
  ) {}

  /**
   * Fan-out connect for every guild in `guildInfo`. Per-slot failures
   * are caught and logged through {@link connectOne}; a single bad
   * guild MUST NOT abort the whole startup — the ConnectionManager's
   * disabled-set is the durable record.
   *
   * Mutation of the BaseBot's guild map is funnelled through the
   * `attachRepos` callback so this connector never holds a writable
   * reference to BaseBot's private state.
   */
  public async connectAll(
    guildInfo: ReadonlyMap<string, GuildInfo>,
    attachRepos: AttachReposFn,
  ): Promise<void> {
    logSystem(this.logger, ops.guildDb.poolStart());
    if (this.mongoURI === undefined || this.mongoURI.length === 0) {
      logSystem(this.logger, ops.guildDb.uriMissing());
      return;
    }
    // Promise.all with per-slot try/catch (rather than allSettled +
    // post-hoc inspection) preserves the prior BaseBot ordering:
    // per-guild success log line interleaves with per-guild
    // connect output, which ops grep against.
    await Promise.all(
      Array.from(guildInfo.entries()).map(async ([guildId, slot]) => {
        try {
          const repos = await this.connectOne(guildId);
          if (repos !== undefined) {
            attachRepos(guildId, repos);
          }
          logSystem(this.logger, ops.guildDb.connectSuccess(guildId, slot.guild.name));
        } catch {
          // connectOne already logged with the manager's
          // traceId; swallow here so fan-out continues — the
          // disabled set in the manager is the durable record
          // handlers read through `bot.connectionManager.isDisabled`.
        }
      }),
    );
  }

  /**
   * Connect (or reuse) ONE guild's repos bag. Returns the freshly
   * built {@link Repos} on success or `undefined` when the bot has no
   * Mongo URI configured. Callers (BaseBot) decide how to publish the
   * result; the connector itself is stateless.
   *
   * Re-throws the normalised `Error` after logging so callers keep
   * the prior control-flow semantics.
   */
  public async connectOne(guildId: string): Promise<Repos | undefined> {
    if (this.mongoURI === undefined || this.mongoURI.length === 0) {
      return undefined;
    }
    const branded = asGuildId(guildId);
    try {
      const reposFactory = this.container.resolve<ReposFactory>(TOKENS.ReposFactory);
      const repos = await reposFactory(branded);
      return repos;
    } catch (err) {
      const normalised =
        err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'connectOne failed');
      const cm = this.container.tryResolve<ConnectionManager>(TOKENS.ConnectionManager);
      const traceId = cm?.isDisabled(branded)?.traceId ?? 'unknown';
      logSystem(this.logger, ops.guildDb.connectFailed(guildId, traceId, normalised.message));
      throw normalised;
    }
  }

  /**
   * Pass-through to {@link ConnectionManager.isDisabled}. Returns
   * `undefined` when the bot was built without a Mongo URI (and
   * therefore has no `ConnectionManager` registered).
   */
  public isDisabled(guildId: string): DisabledGuildState | undefined {
    const cm = this.container.tryResolve<ConnectionManager>(TOKENS.ConnectionManager);
    return cm?.isDisabled(asGuildId(guildId));
  }
}
