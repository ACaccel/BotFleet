/**
 * PluginHost — orchestrates plugin registration and lifecycle.
 *
 * Lifecycle:
 *   register(plugin)*  -- captured immediately; duplicate ids rejected.
 *   initAll()   -- registration order; a throw disables that plugin.
 *   startAll()  -- registration order; same disabled semantics.
 *   readyAll()  -- registration order; failures only logged (already
 *                  past start).
 *   shutdownAll() -- REVERSE registration order; failures only logged.
 *
 * Error isolation: a plugin failure moves the plugin into the
 * {@link DisabledPlugin} set, logs structured, and the phase continues.
 * The bot keeps running with the remaining plugins — no plugin can
 * abort startup.
 *
 * Discord client is intentionally NOT a constructor dependency, so the
 * host stays fully unit-testable without discord.js. It emits an
 * {@link EventDispatcher} that BaseBot attaches to the real
 * `client.on(...)` plumbing.
 *
 * Service-locator guard: plugins receive `services.resolve` (typed
 * tokens only), never the raw container. The host itself takes the
 * container only to satisfy `resolve` calls — it never hands the
 * reference out.
 */
import type { Translator } from '../i18n';
import type { ServiceContainer, ServiceToken } from '../ioc';
import type { Logger } from '../logger';
import type { Clock } from '../time';

import { EventDispatcher } from './event-dispatcher';
import { PluginRegistrationError as PluginRegistrationErrorClass } from './host/errors';
import { PluginLifecycleRunner, type LifecycleHost, type RegisteredPlugin } from './host/lifecycle';
import type { DisabledPlugin, Plugin, PluginId, TypedResolver } from './types';

// Public errors live in `host/errors.ts`. Re-exported here so callers
// can import them from `core/plugin`.
export const PluginRegistrationError = PluginRegistrationErrorClass;
export type PluginRegistrationError = PluginRegistrationErrorClass;

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export interface PluginHostOptions {
  readonly container: ServiceContainer;
  readonly logger: Logger;
  readonly translator: Translator;
  readonly clock: Clock;
}

export class PluginHost {
  private readonly registered = new Map<PluginId, RegisteredPlugin>();
  private readonly disabled = new Map<PluginId, DisabledPlugin>();
  private readonly dispatcher: EventDispatcher;
  /**
   * Lifecycle runner — built lazily so it observes every plugin the
   * composition root staged, whichever order the phases are driven in.
   * Phase logic lives in `host/lifecycle.ts`; the host only wires it.
   */
  private lifecycleRunner: PluginLifecycleRunner | undefined;

  constructor(private readonly options: PluginHostOptions) {
    this.dispatcher = new EventDispatcher(options.logger);
  }

  // -------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------

  /**
   * Register a plugin. The only register-time check is id uniqueness;
   * everything else a plugin needs it validates for itself in its
   * factory (see the plugin contract docstring).
   */
  public register(plugin: Plugin): void {
    if (this.registered.has(plugin.id)) {
      throw new PluginRegistrationError(
        'DUPLICATE_ID',
        `PluginHost.register: plugin id "${plugin.id}" is already registered.`,
        plugin.id,
      );
    }
    this.registered.set(plugin.id, { plugin });
  }

  /** Event dispatcher consumed by BaseBot to attach Discord events. */
  public getEventDispatcher(): EventDispatcher {
    return this.dispatcher;
  }

  /** Snapshot of disabled plugins (id -> reason). */
  public getDisabledPlugins(): readonly DisabledPlugin[] {
    return [...this.disabled.values()];
  }

  /** Snapshot of registration order — the order every phase walks. */
  public getOrder(): readonly PluginId[] {
    return [...this.registered.keys()];
  }

  // -------------------------------------------------------------------
  // Lifecycle — thin delegation to PluginLifecycleRunner
  // -------------------------------------------------------------------

  /** Run `init` on every enabled plugin in registration order. */
  public async initAll(): Promise<void> {
    await this.getLifecycleRunner().runInit();
  }

  /**
   * Run `start` on every enabled plugin in registration order, then
   * attach every enabled plugin's event subscriptions to the host's
   * {@link EventDispatcher}.
   *
   * Wiring contract for BaseBot: events do **not** flow until
   * `startAll()` resolves. Callers MUST defer
   * `client.on(name, (...args) => host.getEventDispatcher().emit(name, ...args))`
   * until after the awaited `startAll()` returns, otherwise plugins
   * whose `start` hook hasn't finished can still observe events and
   * see a partially-initialised world.
   */
  public async startAll(): Promise<void> {
    await this.getLifecycleRunner().runStart();
  }

  /** Run `onReady` on every enabled plugin in registration order. */
  public async readyAll(): Promise<void> {
    await this.getLifecycleRunner().runReady();
  }

  /** Notify enabled plugins that a guild database has become available. */
  public async guildDatabaseReady(guildId: string): Promise<void> {
    await this.getLifecycleRunner().runGuildDatabaseReady(guildId);
  }

  /**
   * Run `onShutdown` in **reverse** registration order. Failures are
   * always non-fatal here — the bot is shutting down regardless.
   */
  public async shutdownAll(): Promise<void> {
    await this.getLifecycleRunner().runShutdown();
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  /**
   * Lazily build the lifecycle runner, exposing the host's state to it
   * through the narrow {@link LifecycleHost} interface.
   */
  private getLifecycleRunner(): PluginLifecycleRunner {
    if (this.lifecycleRunner === undefined) {
      this.lifecycleRunner = new PluginLifecycleRunner(this.buildLifecycleHost());
    }
    return this.lifecycleRunner;
  }

  /** Adapt the host's mutable state into the narrow {@link LifecycleHost}. */
  private buildLifecycleHost(): LifecycleHost {
    return {
      registered: this.registered,
      disabled: this.disabled,
      resolve: this.buildResolver(),
      // Container is exposed to the lifecycle runner so it can publish
      // plugin-registered instances via `registerInstance`. The narrow
      // `LifecycleHost` interface keeps this from widening any further
      // boundary — plugins still receive only the typed-token resolver
      // and the `registerInstance` facade, never the container itself.
      container: this.options.container,
      dispatcher: this.dispatcher,
      logger: this.options.logger,
      translator: this.options.translator,
      clock: this.options.clock,
    };
  }

  private buildResolver(): TypedResolver {
    const container = this.options.container;
    return <T>(token: ServiceToken<T>): T => container.resolve<T>(token);
  }
}
