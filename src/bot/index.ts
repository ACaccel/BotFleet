/**
 * `BaseBot` — thin lifecycle owner.
 *
 * BaseBot is a small orchestrator composed with three single-purpose
 * collaborators:
 *
 *   - {@link GuildRegistrar} — assembles `GuildInfo` from the Discord
 *     cache + bot config (`registerAll`).
 *   - {@link ClientEventBridge} — Adapter from `client.on(...)` raw
 *     events to router dispatch, plugin EventDispatcher, reaction
 *     port, and the GuildCreate fallback.
 *   - {@link GuildDbConnector} — owns per-guild Mongo connection
 *     fan-out and failure normalisation.
 *
 * BaseBot itself stages plugins (`use`), wires the IoC container,
 * builds the PluginHost, runs the startup phases in order, and tears
 * them down in reverse for `shutdown`. Subclasses extend by registering
 * plugins in their constructor and by overriding `eventBridgeSuppression`.
 */
import type { Channel, Client, Guild, Role } from 'discord.js';
import { Events } from 'discord.js';
import type { Job } from 'node-schedule';

import type { ButtonHandler } from '@button';
import { registerButtons } from '@button';
import type { Command } from '@cmd';
import { registerCommands } from '@cmd';
import type { ModalHandler } from '@modal';
import { registerModals } from '@modal';
import type { ReactionHandler } from '@reaction';
import { executeReactionAdded, executeReactionRemoved, registerReactions } from '@reaction';
import type { SSMHandler } from '@select-menu';
import { registerSSMs } from '@select-menu';

import { createBootstrapLogger, loadEnv, type Env } from '../core/config';
import { ConfigurationError } from '../core/errors';
import type { GuildRegistry } from './guild-registry';
import type { Translator } from '../core/i18n';
import { createDefaultTranslator, isLocale } from '../core/i18n';
import type { asGuildId } from '../core/ids';
import { createContainer, type ServiceContainer } from '../core/ioc';
import { installProcessHandlers, logError, logSystem, ops, type Logger } from '../core/logger';
import {
  createPermissionRankPolicy,
  InteractionRouter,
  PluginHost,
  type PermissionRankConfig,
  type PermissionRankPolicy,
  type Plugin,
} from '../core/plugin';
import { systemClock, type Clock } from '../core/time';
import { MongoConnectionManager, type ConnectionManager } from '../infra/mongo/connection-manager';
import { buildRepos, type Repos } from '../persistence/repositories';
import type { ModelCatalog } from '../infra/llm/models-catalog';
import type { DefaultModelResolver } from '../infra/llm/default-model-resolver';
import type { FeedPlatformRegistry } from '../infra/social-feed';

import {
  ClientEventBridge,
  type ClientEventBridgeSuppression,
  type ReactionHandlerPort,
} from './client-event-bridge';
import { installClientSafetyListeners } from './client-safety-listeners';
import { GuildDbConnector } from './guild-db-connector';
import { BaseBotGuildOnboardingPort } from './guild-onboarding';
import { GuildRegistrar } from './guild-registrar';
import { resolveLocalesDir } from './locales-dir';
import { createChannelLoggingMiddleware, createDispatchMiddleware } from './middlewares';
import { TOKENS, type ReposFactory } from './tokens';

/**
 * Process-wide pool of {@link MongoConnectionManager}s keyed by base
 * URI. Two BaseBots sharing a URI reuse the same manager (and thus
 * the same per-guild connection pool), and tests / multi-cluster
 * setups that pass distinct URIs get distinct managers.
 */
const sharedConnectionManagers = new Map<string, MongoConnectionManager>();
const sharedConnectionManagerForUri = (uri: string): MongoConnectionManager => {
  const existing = sharedConnectionManagers.get(uri);
  if (existing !== undefined) return existing;
  const created = new MongoConnectionManager(uri);
  sharedConnectionManagers.set(uri, created);
  return created;
};

export interface Config {
  /** Discord user ids granted bot-admin privileges (e.g. `/ai_whitelist_*`). */
  admin?: string[];
  guilds?: Record<string, GuildConfig>;
  commands?: string[];
  /**
   * Default display locale for this bot's user-facing text. Optional —
   * omit to use the framework default (`zh-TW`). Supported values are
   * the members of `SUPPORTED_LOCALES` (`'zh-TW' | 'en'`). Typed as a
   * plain `string` because it arrives from untrusted `config.json`; it
   * is validated with `isLocale` in `buildHost`, and an unsupported
   * value is ignored with a warning and falls back to the default.
   */
  language?: string;
}

export interface GuildInfo {
  readonly bot_name: string;
  readonly guild: Guild;
  readonly channels?: Readonly<Record<string, Channel>>;
  readonly roles?: Readonly<Record<string, Role>>;
  /** Per-guild repository bag built from the IoC container at connect time. */
  readonly repos?: Repos;
}

interface GuildConfig {
  /**
   * Symbolic channel-name -> Discord channel id. Optional: a guild that
   * omits it (or omits the whole `guilds` block) keeps every feature but
   * silently skips channel-bound side effects — debug logging and the
   * guild-event mirror have nothing to send to. `GuildRegistrar` resolves
   * a missing map to an empty record; consumers null-check downstream.
   */
  channels?: Record<string, string>;
  /** Symbolic role-name -> Discord role id. Optional, same semantics as {@link channels}. */
  roles?: Record<string, string>;
  /**
   * Privacy / clearance ranks for this guild's channels and roles, plus the
   * per-feature channel-rank ceilings. Consumed by {@link
   * TOKENS.PermissionRankPolicy}. Distinct from {@link roles} above: that map
   * is symbolic-name -> id for `GuildRegistry.getRole`, whereas
   * `permission_rank.roles` is keyed by raw Discord role id (the form
   * `member.roles.cache.keys()` yields) -> numeric rank. Optional; an omitted
   * block ranks every channel / user 0 and suppresses nothing.
   */
  permission_rank?: PermissionRankConfig;
}

/**
 * Thin lifecycle owner. Wires the IoC container, stages plugins, then
 * delegates Guild registration, Discord event fan-out, and per-guild
 * Mongo lifecycle to the three injected collaborators
 * ({@link GuildRegistrar}, {@link ClientEventBridge},
 * {@link GuildDbConnector}). Subclasses register plugins in their
 * constructor and override the `protected` hook declared at the bottom
 * of this class.
 */
export abstract class BaseBot<TConfig extends Config = Config> {
  // ---- public state (handlers read these) ----
  /**
   * Composition-root IoC container. Owned by BaseBot, populated in
   * the constructor with `ConnectionManager` + `ReposFactory`. Other
   * layers must NOT import this container — handlers reach repos via
   * `bot.getRepos(guildId)`. The eslint `no-restricted-imports`
   * rule enforces the constraint.
   */
  public readonly container: ServiceContainer;
  public client: Client;
  public clientId: string;
  /** Discord user ids granted bot-admin privileges; resolved from `config.admin`. */
  public adminIds: string[] = [];
  public config: TConfig;

  /**
   * Backing store for guild metadata. Private (ECMAScript hard-private)
   * so no caller outside BaseBot can mutate it. Read access goes through
   * {@link getGuildInfo} / {@link getAllGuildInfo} / {@link getRepos};
   * writes go through {@link setGuildInfo} / {@link attachRepos}, both
   * of which are private and reachable only from this class.
   */
  readonly #guildInfo = new Map<string, GuildInfo>();

  /** Look up one guild's info. Returns undefined when unregistered. */
  public getGuildInfo(guildId: string): Readonly<GuildInfo> | undefined {
    return this.#guildInfo.get(guildId);
  }

  /** Readonly view over every registered guild. */
  public getAllGuildInfo(): ReadonlyMap<string, Readonly<GuildInfo>> {
    return this.#guildInfo;
  }

  /** Convenience accessor for the common case of just needing repos. */
  public getRepos(guildId: string): Repos | undefined {
    return this.#guildInfo.get(guildId)?.repos;
  }

  /**
   * Register / replace one guild's slot. Private to BaseBot — only
   * BaseBot itself (via `handleClientReady`) and the in-package
   * onboarding port reach it. The port uses
   * {@link registerGuildSlotInternal} which forwards here.
   */
  private setGuildInfo(guildId: string, info: GuildInfo): void {
    this.#guildInfo.set(guildId, info);
  }

  /**
   * Update a guild's `bot_name` after a successful `/change_avatar`
   * flip. A narrow seam exposed so handlers do not need (and are not
   * allowed) to reach into the underlying map. No-op when the slot
   * has not been registered.
   */
  public updateBotName(guildId: string, botName: string): void {
    const existing = this.#guildInfo.get(guildId);
    if (existing === undefined) return;
    this.#guildInfo.set(guildId, { ...existing, bot_name: botName });
  }

  /**
   * Composition-root-only seam for the `BaseBotGuildOnboardingPort` to
   * publish a freshly built `GuildInfo` slot when a guild is joined at
   * runtime. Not part of the public BaseBot surface — handlers and
   * plugins MUST read through {@link getGuildInfo} and never call this.
   *
   * @internal
   */
  public registerGuildSlotInternal(guildId: string, info: GuildInfo): void {
    this.setGuildInfo(guildId, info);
  }

  /**
   * Attach a freshly-built repos bag to an existing guild slot. Private
   * to BaseBot. No-op when the slot has not been registered yet — the
   * design always registers the guild before connecting its DB.
   */
  private attachRepos(guildId: string, repos: Repos): void {
    const existing = this.#guildInfo.get(guildId);
    if (existing === undefined) return;
    this.#guildInfo.set(guildId, { ...existing, repos });
  }

  public commandHandlers: Map<string, Command> = new Map();
  public buttonHandlers: Map<string, ButtonHandler> = new Map();
  public modalHandlers: Map<string, ModalHandler> = new Map();
  public ssmHandlers: Map<string, SSMHandler> = new Map();
  public reactionHandlers: Map<string, ReactionHandler> = new Map();
  public helpMessage: string = '';

  /**
   * Backing store for the bot's scheduled jobs. Private so the container
   * binding below is the single way in: plugins reach it as
   * `TOKENS.JobMap`, handler-side bridges as {@link jobMap}, and both
   * land on this one map.
   */
  readonly #jobs = new Map<string, Job>();

  /**
   * Bot-scoped LLM {@link ModelCatalog}. Resolved from the IoC
   * container on every access: `LlmChatPlugin.init` publishes
   * it under `TOKENS.ModelCatalog` through `ctx.registerInstance`,
   * and bots that do not register the plugin see `undefined`. The
   * `/ai_settings` handler reaches the live model list through this
   * getter so the prior `listProviderModels` module-global is no
   * longer needed.
   */
  public get modelCatalog(): ModelCatalog | undefined {
    return this.container.tryResolve<ModelCatalog>(TOKENS.ModelCatalog);
  }

  /**
   * Bot-scoped {@link DefaultModelResolver}, published by
   * `LlmChatPlugin.init`. Handlers (notably `ai_whitelist_add`) read
   * the cheapest still-listed default model through this getter; bots
   * without LlmChatPlugin see `undefined` and fall back to the static
   * `DEFAULT_MODELS` seed.
   */
  public get defaultModelResolver(): DefaultModelResolver | undefined {
    return this.container.tryResolve<DefaultModelResolver>(TOKENS.DefaultModelResolver);
  }

  /**
   * Bot-scoped {@link FeedPlatformRegistry}, registered by the
   * composition root from its `social_feed.platforms` block. The
   * `/feed_*` commands read it through this getter rather than the
   * container; bots that do not configure the feature see `undefined`.
   */
  public get feedPlatformRegistry(): FeedPlatformRegistry | undefined {
    return this.container.tryResolve<FeedPlatformRegistry>(TOKENS.FeedPlatformRegistry);
  }

  /**
   * Bot-scoped {@link PermissionRankPolicy}. Built once from static
   * config in the constructor and registered eagerly under
   * `TOKENS.PermissionRankPolicy`; resolved here on demand. Handlers
   * (notably `/traffic`) read the operator-defined channel / user
   * privacy ranking through this getter rather than touching the
   * container or `TOKENS` directly — the same boundary `getRepos`
   * enforces for repositories. `undefined` only in the pre-`run()`
   * window before the container is wired.
   */
  public get permissionRankPolicy(): PermissionRankPolicy | undefined {
    return this.container.tryResolve<PermissionRankPolicy>(TOKENS.PermissionRankPolicy);
  }

  /** Bot-scoped {@link Translator}. Undefined only in the pre-`run()` window. */
  public translator: Translator | undefined;

  /** Bot-scoped structured logger. Undefined only in the pre-`run()` window. */
  public logger: Logger | undefined;

  /** Typed, validated process environment. Undefined when env validation failed at boot. */
  public env: Env | undefined;

  // ---- protected hook fields ----

  /**
   * Translator key for the bot's `/help` body. Subclasses set this in
   * their constructor; {@link run} resolves it once the translator is
   * loaded and stores the rendered string in {@link helpMessage}.
   * Holding the key (rather than the rendered text) in subclasses
   * keeps composition roots CJK-free, which the i18n scanner enforces.
   */
  protected helpMessageKey?: string;

  /** Built inside {@link run}; consumed by the {@link ClientEventBridge}. */
  protected interactionRouter: InteractionRouter | undefined;

  private readonly token: string;
  private readonly mongoURI?: string;
  private readonly localesDir: string;
  private readonly pendingPlugins: Plugin[] = [];
  private pluginHost: PluginHost | undefined;

  // ---- collaborators ----
  private readonly guildRegistrar: GuildRegistrar;
  private readonly clientEventBridge: ClientEventBridge;
  private readonly guildDbConnector: GuildDbConnector;

  public constructor(
    client: Client,
    token: string,
    mongoURI: string,
    clientId: string,
    config: TConfig,
    localesDir: string = resolveLocalesDir(),
  ) {
    this.token = token;
    this.mongoURI = mongoURI;
    this.client = client;
    this.clientId = clientId;
    this.config = config;
    this.adminIds = config.admin ?? [];
    // The composition root injects the locales path; `core/i18n`
    // does not resolve it from `__dirname`. Subclasses get the
    // canonical monorepo layout for free via the default and can
    // override the parameter for bespoke deployments (e.g.
    // npm-packaged bundle, alternative content root).
    this.localesDir = localesDir;

    this.container = createContainer();
    // Logger is the first registration so downstream factories may
    // resolve it for their own structured logs. Bound with
    // `{ bot: clientId }` so every line carries the bot identity.
    this.container.registerSingleton(TOKENS.Logger, () =>
      createBootstrapLogger({ bot: this.clientId }),
    );
    // ConnectionManager is process-shared via
    // `sharedConnectionManagerForUri` — one pool per URI keeps
    // multi-bot processes from opening duplicate Mongo connections.
    //
    // A database-free bot (gopher: empty `mongoURI`) leaves the token
    // unbound rather than binding a factory that throws. That is what
    // makes the documented `connectionManager` getter contract true —
    // `tryResolve` returns `undefined` instead of propagating the
    // factory's throw to every null-checking caller.
    const uri = this.mongoURI;
    if (uri !== undefined && uri.length > 0) {
      this.container.registerSingleton(TOKENS.ConnectionManager, () =>
        sharedConnectionManagerForUri(uri),
      );
    }
    const reposFactory: ReposFactory = async (guildId: ReturnType<typeof asGuildId>) => {
      const cm = this.container.resolve<ConnectionManager>(TOKENS.ConnectionManager);
      const guildConn = await cm.getConnection(guildId);
      return buildRepos(guildConn);
    };
    this.container.registerSingleton(TOKENS.ReposFactory, () => reposFactory);
    this.container.registerSingleton(TOKENS.Clock, () => systemClock);
    // GuildRegistry is a read-only view over `#guildInfo` so
    // plugins reach guild lookup without holding a BaseBot reference.
    const guildRegistry: GuildRegistry = {
      getRepos: (guildId) => this.#guildInfo.get(guildId)?.repos,
      getChannel: (guildId, name) => this.#guildInfo.get(guildId)?.channels?.[name],
      getRole: (guildId, name) => this.#guildInfo.get(guildId)?.roles?.[name],
      listGuildIds: () => Array.from(this.#guildInfo.keys()),
    };
    this.container.registerSingleton(TOKENS.GuildRegistry, () => guildRegistry);
    this.container.registerSingleton(TOKENS.DiscordClient, () => this.client);
    this.container.registerSingleton(TOKENS.JobMap, () => this.#jobs);
    this.container.registerSingleton(
      TOKENS.GuildOnboardingPort,
      () => new BaseBotGuildOnboardingPort(this),
    );
    // PermissionRankPolicy is built ONCE from static config here (eagerly, not
    // lazily) so a malformed `permission_rank` block fails fast at
    // construction, and so event-time consumers never observe an unbuilt
    // policy.
    const permissionRankByGuild: Record<string, PermissionRankConfig | undefined> = {};
    for (const [guildId, guildConfig] of Object.entries(this.config.guilds ?? {})) {
      permissionRankByGuild[guildId] = guildConfig.permission_rank;
    }
    const permissionRankPolicy = createPermissionRankPolicy(permissionRankByGuild);
    this.container.registerSingleton(TOKENS.PermissionRankPolicy, () => permissionRankPolicy);

    // Construct collaborators with a bootstrap logger so they have a
    // structured sink before the bot-scoped Logger is wired in `run()`.
    // The bootstrap logger from the container is the same instance
    // `setupContainer` exposes as `this.logger`, so log ownership stays
    // single-sourced.
    const bootstrapLogger = this.container.resolve<Logger>(TOKENS.Logger);
    this.guildRegistrar = new GuildRegistrar(this.client, this.clientId, bootstrapLogger);
    this.clientEventBridge = new ClientEventBridge(this.client, bootstrapLogger);
    this.guildDbConnector = new GuildDbConnector(this.container, this.mongoURI, bootstrapLogger);
  }

  // ---- typed accessors handlers read through ----

  /**
   * Live shared {@link ConnectionManager}. Returns `undefined` only
   * in the pre-`run()` window or when the bot was constructed without
   * a `MONGO_URI`; handler callsites null-check before reading.
   */
  public get connectionManager(): ConnectionManager | undefined {
    return this.container.tryResolve<ConnectionManager>(TOKENS.ConnectionManager);
  }

  /**
   * The canonical read-only view over this bot's guild slots — the same
   * object plugins resolve as `TOKENS.GuildRegistry`. Each plugin's
   * handler-side `deps-from-bot` bridge reads it here instead of
   * rebuilding an adapter, so both sides of a plugin observe one lookup
   * implementation. Registered in the constructor, so it resolves from
   * the moment the bot exists.
   */
  public get guildRegistry(): GuildRegistry {
    return this.container.resolve<GuildRegistry>(TOKENS.GuildRegistry);
  }

  /**
   * This bot's scheduled jobs — the same map plugins resolve as
   * `TOKENS.JobMap`. See {@link guildRegistry} for why the accessor
   * routes through the container.
   */
  public get jobMap(): Map<string, Job> {
    return this.container.resolve<Map<string, Job>>(TOKENS.JobMap);
  }

  /**
   * The bot-scoped logger, narrowed. {@link logger} is optional only to
   * describe the pre-`run()` window; every interaction- or event-driven
   * caller runs long after `setupContainer` bound it, so this accessor
   * hands them a `Logger` instead of an `undefined` they would have to
   * cast away. Reaching the throw means a caller ran before startup —
   * a programmer error, raised as `TypeError` per the convention in
   * `core/ids.ts`.
   */
  public requireLogger(): Logger {
    const logger = this.logger;
    if (logger === undefined) {
      throw new TypeError('BaseBot.requireLogger: called before run() bound the logger');
    }
    return logger;
  }

  // ---- lifecycle ----

  /**
   * Stage a plugin for registration. Fluent for subclass constructors.
   */
  public use(plugin: Plugin): this {
    this.pendingPlugins.push(plugin);
    return this;
  }

  /** Expose the host for tests / inspection. Undefined before {@link run}. */
  public getPluginHost(): PluginHost | undefined {
    return this.pluginHost;
  }

  public getMongoURI(): string | undefined {
    return this.mongoURI;
  }

  public getToken(): string {
    return this.token;
  }

  /**
   * Orchestrator. Walks the startup phases in dependency order:
   *
   *   1. setupContainer       — env, logger, process safety nets
   *   2. buildHost            — translator, router, host.initAll
   *   3. armReadyLatch        — register ClientReady listener (deferred)
   *   4. login                — Discord side
   *   5. host.startAll        — collect plugin event subscriptions
   *   6. clientEventBridge.attach — wire raw + dispatcher listeners
   *   7. releaseReadyLatch    — unblock (or abort) the deferred
   *                             ClientReady body
   */
  public run = async (callback?: () => Promise<void>): Promise<void> => {
    const rootLogger = this.setupContainer();
    const host = await this.buildHost(rootLogger);
    const releaseReadyLatch = this.armReadyLatch(callback);
    let startupSucceeded = false;
    try {
      await this.login();
      // start runs after login but BEFORE the bridge attaches — the
      // dispatcher's subscription list stabilises inside startAll().
      await host.startAll();
      this.clientEventBridge.attach({
        container: this.container,
        host,
        router: this.interactionRouter,
        reactionPort: this.buildReactionPort(),
        guildInfo: () => this.#guildInfo,
        suppression: this.eventBridgeSuppression(),
      });
      startupSucceeded = true;
    } finally {
      // The latch is released on every path, carrying whether startup
      // actually completed. Never releasing it would strand a
      // `ClientReady` that fired before a later phase threw; releasing
      // it as a success would send that handler off to register guilds
      // and commands on a bot whose plugin host failed to start and
      // whose event bridge never attached — concurrently with the
      // caller's `process.exit(1)`.
      releaseReadyLatch(startupSucceeded);
    }
  };

  /**
   * Reverse-order shutdown:
   *
   *   pluginHost.shutdownAll → clientEventBridge.detach
   *     → client.destroy → ConnectionManager.closeAll
   *
   * Best-effort: each step is wrapped so one failure does not abort
   * the rest of the teardown.
   */
  public shutdown = async (): Promise<void> => {
    const log = this.container.tryResolve<Logger>(TOKENS.Logger);
    if (this.pluginHost !== undefined) {
      try {
        await this.pluginHost.shutdownAll();
      } catch (e: unknown) {
        log?.warn(
          { err: e instanceof Error ? e : new Error(String(e)) },
          'shutdown: pluginHost.shutdownAll threw; continuing teardown',
        );
      }
    }
    try {
      this.clientEventBridge.detach();
    } catch (e: unknown) {
      log?.warn(
        { err: e instanceof Error ? e : new Error(String(e)) },
        'shutdown: clientEventBridge.detach threw',
      );
    }
    try {
      this.client.destroy();
    } catch (e: unknown) {
      log?.warn(
        { err: e instanceof Error ? e : new Error(String(e)) },
        'shutdown: client.destroy threw',
      );
    }
    // A database-free bot leaves the token unbound, so `tryResolve`
    // yields `undefined` and there is nothing to close.
    try {
      const cm = this.container.tryResolve<ConnectionManager>(TOKENS.ConnectionManager);
      await cm?.closeAll();
    } catch (e: unknown) {
      log?.warn(
        { err: e instanceof Error ? e : new Error(String(e)) },
        'shutdown: connection manager closeAll threw',
      );
    }
  };

  public reLogin = async (): Promise<void> => {
    await this.client.login(this.token);
  };

  /**
   * Open (or reuse) the per-guild MongoDB connection and populate
   * `guildInfo[g].repos`. Delegates to the {@link GuildDbConnector}
   * collaborator. Re-throws on failure so existing callers
   * (`connectGuildDB`, the {@link BaseBotGuildOnboardingPort}) keep
   * their prior control-flow semantics.
   */
  public connectOneGuild = async (guildId: string): Promise<void> => {
    const slot = this.#guildInfo.get(guildId);
    if (slot === undefined) return;
    const repos = await this.guildDbConnector.connectOne(guildId);
    if (repos !== undefined) {
      this.attachRepos(guildId, repos);
    }
  };

  /**
   * Fan-out per-guild Mongo connect across `guildInfo`. Delegates to
   * the {@link GuildDbConnector} collaborator.
   */
  public connectGuildDB = async (): Promise<void> => {
    await this.guildDbConnector.connectAll(this.#guildInfo, (guildId, repos) =>
      this.attachRepos(guildId, repos),
    );
  };

  // ---- subclass hooks ----

  /**
   * Subclass hook controlling which {@link ClientEventBridge}
   * listeners are installed. Default installs every listener. Bots
   * that opt out of an interaction class (the LLM-only `Konata`, the
   * worker-style `MsgArchive`) override this and flip the relevant
   * flags to `true`. Suppression is declared through this single hook
   * rather than by overriding per-listener methods, so BaseBot keeps
   * one explicit opt-out surface instead of scattered listener stubs.
   */
  protected eventBridgeSuppression(): ClientEventBridgeSuppression {
    return {};
  }

  // ---- private orchestration helpers ----

  /**
   * Phase 1: bind structured logger, install process safety nets,
   * load typed Env. Returns the bot-scoped logger so the caller can
   * hand it to phase 2 without resolving the container twice.
   */
  private setupContainer(): Logger {
    const rootLogger = this.container.resolve<Logger>(TOKENS.Logger);
    this.logger = rootLogger;
    installProcessHandlers({
      logger: rootLogger,
      gracefulShutdown: () => this.shutdown(),
    });
    // Connection-layer safety net: keep a transient gateway socket reset
    // (ECONNRESET / "socket hang up") from escaping as an uncaughtException
    // that would crash the whole process. Installed here so it spans the
    // client's full lifecycle, including login (see client-safety-listeners).
    installClientSafetyListeners({ client: this.client, logger: rootLogger });
    try {
      // An empty `mongoURI` means the bot was built without a database
      // (e.g. gopher), matching how `GuildDbConnector` / `ConnectionManager`
      // already treat `undefined`-or-empty. Without the length check an
      // empty string would (wrongly) demand a valid `MONGO_URI` here.
      const env = loadEnv({
        exitOnFailure: false,
        requireDb: this.mongoURI !== undefined && this.mongoURI.length > 0,
      });
      this.container.registerSingleton(TOKENS.Env, () => env);
      this.env = env;
    } catch (envErr: unknown) {
      rootLogger.warn(
        { err: envErr instanceof Error ? envErr : new Error(String(envErr)) },
        'BaseBot.run: typed Env load failed; TOKENS.Env will be unbound. Plugins requiring it (e.g. LlmChatPlugin) will fail at init.',
      );
    }
    return rootLogger;
  }

  /**
   * Phase 2: resolve the Translator, assemble the InteractionRouter
   * Chain-of-Responsibility, build the PluginHost, register pending
   * plugins, run host `initAll()`.
   */
  private async buildHost(rootLogger: Logger): Promise<PluginHost> {
    // Per-bot display language: drive the translator's locale from the
    // bot's `config.json`. An unsupported value is rejected here (rather
    // than silently producing missing-key fallbacks downstream) and the
    // translator reverts to DEFAULT_LOCALE.
    const configuredLocale = isLocale(this.config.language) ? this.config.language : undefined;
    if (this.config.language !== undefined && configuredLocale === undefined) {
      rootLogger.warn(
        { language: this.config.language },
        'BaseBot.buildHost: config.language is not a supported locale; falling back to DEFAULT_LOCALE.',
      );
    }
    const translator = await createDefaultTranslator({
      localesDir: this.localesDir,
      fallbackLocale: configuredLocale,
    });
    this.container.registerSingleton(TOKENS.Translator, () => translator);
    this.translator = translator;
    if (this.helpMessageKey !== undefined) {
      this.helpMessage = translator.t(this.helpMessageKey);
    }
    // Assemble the Chain-of-Responsibility interaction router: the
    // terminal dispatch stage followed by the observability stage.
    this.interactionRouter = new InteractionRouter();
    this.interactionRouter.use(createDispatchMiddleware(this));
    this.interactionRouter.use(
      createChannelLoggingMiddleware(this, {
        policy: this.container.resolve(TOKENS.PermissionRankPolicy),
      }),
    );

    const host = new PluginHost({
      container: this.container,
      logger: rootLogger,
      translator,
      clock: this.container.resolve<Clock>(TOKENS.Clock),
    });
    for (const plugin of this.pendingPlugins) {
      host.register(plugin);
    }
    this.pluginHost = host;
    await host.initAll();
    return host;
  }

  /**
   * Phase 3 prelude: register the `ClientReady` listener BEFORE
   * `client.login()` so a fast-firing ready event is not missed. The
   * latch lets the handler observe a fully-set-up host (startAll
   * done, bridge attached) before invoking `host.readyAll()`, and
   * carries a success flag so a failed startup aborts the handler
   * rather than running it against half-wired state.
   */
  private armReadyLatch(callback?: () => Promise<void>): (startupSucceeded: boolean) => void {
    let releaseReadyLatch: (startupSucceeded: boolean) => void = () => {};
    const readyLatch = new Promise<boolean>((resolve) => {
      releaseReadyLatch = resolve;
    });
    this.client.once(Events.ClientReady, async () => {
      const startupSucceeded = await readyLatch;
      // A failed startup is terminal (see `runOrExit`); proceeding here
      // would build guild state on a half-wired bot that is about to
      // exit.
      if (!startupSucceeded) return;
      await this.handleClientReady(callback);
    });
    return releaseReadyLatch;
  }

  /**
   * Body of the `clientReady` handler. Runs guild registration, Mongo
   * fan-out, handler-registry build-out, reboot fan-out, the optional
   * caller callback, and finally `host.readyAll()`.
   */
  private async handleClientReady(callback?: () => Promise<void>): Promise<void> {
    try {
      const registered = this.guildRegistrar.registerAll(this.config);
      for (const [guildId, info] of Object.entries(registered)) {
        this.setGuildInfo(guildId, info);
      }
      await this.guildDbConnector.connectAll(this.#guildInfo, (guildId, repos) =>
        this.attachRepos(guildId, repos),
      );
      await registerCommands(this);
      await registerButtons(this);
      await registerSSMs(this);
      await registerModals(this);
      await registerReactions(this);
      await this.clientEventBridge.sendRebootMessages(this.translator);
      if (callback !== undefined) {
        await callback();
      }
      // readyAll runs AFTER clientReady so plugins observe a
      // fully-online client when their `onReady` hook fires.
      // Failures here are logged but never fatal — the bot is
      // already serving, mirroring the host docstring policy.
      if (this.pluginHost !== undefined) {
        try {
          await this.pluginHost.readyAll();
        } catch (readyErr: unknown) {
          logError(this.logger, null, readyErr);
        }
      }
    } catch (err) {
      logError(this.logger, null, err);
    }
  }

  /**
   * Phase 4: Discord side of the login dance.
   *
   * Both failure paths raise a `ConfigurationError` and reject so
   * `run()` aborts instead of continuing into `startAll()` /
   * `connectGuildDB()` with a half-attached client. Treated as a
   * startup-time configuration failure (bad token, network, or a
   * gateway handshake that never produced a `client.user`).
   */
  private async login(): Promise<void> {
    try {
      await this.client.login(this.token);
    } catch (cause) {
      const error = new ConfigurationError({
        code: 'BOT_LOGIN_FAILED',
        messageKey: 'errors:bot.login_failed',
        messageParams: { clientId: this.clientId },
        context: { operation: 'BaseBot.login', input: { clientId: this.clientId } },
        cause,
      });
      logError(this.logger, null, error);
      throw error;
    }
    if (this.client.user === null) {
      const error = new ConfigurationError({
        code: 'BOT_LOGIN_NO_USER',
        messageKey: 'errors:bot.login_no_user',
        messageParams: { clientId: this.clientId },
        context: { operation: 'BaseBot.login', input: { clientId: this.clientId } },
      });
      logError(this.logger, null, error);
      throw error;
    }
    logSystem(this.logger, ops.bot.online(this.client.user.displayName));
  }

  /** True when `userId` is one of this bot's configured admins. */
  public isAdmin(userId: string): boolean {
    return this.adminIds.includes(userId);
  }

  /**
   * Build the `ReactionHandlerPort` the bridge consumes. The reaction
   * codegen entry points (`executeReactionAdded` / `executeReactionRemoved`)
   * accept a `BaseBot` reference; the port adapts them so the bridge
   * itself stays decoupled from the bot.
   */
  private buildReactionPort(): ReactionHandlerPort {
    return {
      handleAdded: (reaction, user) => executeReactionAdded(reaction, user, this),
      handleRemoved: (reaction, user) => executeReactionRemoved(reaction, user, this),
    };
  }
}
