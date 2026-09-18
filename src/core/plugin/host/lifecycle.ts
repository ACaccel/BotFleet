/**
 * Plugin lifecycle runner — owns the `init` / `start` / `onReady` /
 * `onShutdown` phase execution for `PluginHost`.
 *
 * Design rationale: the lifecycle phases live in their own module so
 * adding, removing, or changing a phase is a single-file edit and is
 * independently unit-testable. Coupling to the host is constrained by
 * the narrow {@link LifecycleHost} interface — the compiler forbids
 * this module from reaching into arbitrary host internals, so
 * modularity is type-enforced rather than discipline-enforced.
 */
import { ConfigurationError } from '../../errors';
import type { Translator } from '../../i18n';
import type { ServiceContainer, ServiceToken } from '../../ioc';
import type { Logger } from '../../logger';
import type { Clock } from '../../time';
import type { EventDispatcher } from '../event-dispatcher';
import type {
  DisabledPlugin,
  Plugin,
  PluginEventSubscriptions,
  PluginId,
  PluginInitContext,
  PluginRuntimeContext,
  PluginRuntimeServices,
  PluginStartContext,
  RegisterInstance,
  TypedResolver,
} from '../types';

/**
 * Discrete lifecycle phases the runner walks through. `'idle'` is the
 * pre-`runInit` start state; `'running'` is everything after a phase's
 * synchronous body has returned (including the gap between phases) so
 * late-arriving async callbacks from a finished hook still see a
 * non-`'init'` phase. `'shutdown'` is set for the duration of
 * `runShutdown`.
 */
type LifecyclePhase = 'idle' | 'init' | 'start' | 'ready' | 'running' | 'shutdown';

/**
 * A registered plugin. Mirrors the host's internal entry; declared here
 * so the runner does not depend on a host-private type.
 */
export interface RegisteredPlugin {
  readonly plugin: Plugin;
}

/**
 * Narrow slice of `PluginHost` state the lifecycle runner needs. The
 * host passes itself (adapted) as this interface; the runner can touch
 * nothing else. This is the type-level boundary that keeps
 * `lifecycle.ts` from becoming a "second half of host".
 */
export interface LifecycleHost {
  /**
   * Registered plugins, keyed by id. Read-only for the runner. `Map`
   * iteration order is registration order, which is the order every
   * phase walks (reversed for shutdown).
   */
  readonly registered: ReadonlyMap<PluginId, RegisteredPlugin>;
  /** Disabled-plugin map — the runner both reads and writes this. */
  readonly disabled: Map<PluginId, DisabledPlugin>;
  /** Typed-token resolver handed to plugin contexts. */
  readonly resolve: TypedResolver;
  /**
   * Container the runner uses to publish plugin-registered instances
   * (see {@link RegisterInstance}). The narrow `LifecycleHost` is the
   * single boundary through which the runner can mutate container
   * state; no other path is exposed.
   */
  readonly container: ServiceContainer;
  /** Event dispatcher subscriptions are attached to after `start`. */
  readonly dispatcher: EventDispatcher;
  readonly logger: Logger;
  readonly translator: Translator;
  readonly clock: Clock;
}

/**
 * Runs plugin lifecycle phases against a {@link LifecycleHost}.
 *
 * Error isolation contract: a plugin failure disables that plugin and
 * the phase continues with the rest. No plugin failure aborts startup.
 * `onShutdown` failures are likewise logged and swallowed.
 */
export class PluginLifecycleRunner {
  /**
   * Current lifecycle phase. Mutated only by `runInit` / `runStart` /
   * `runReady` / `runShutdown` (and their `finally` blocks).
   *
   * Captured by the `registerInstance` closure built in
   * {@link buildInitContext} so that even a plugin which stores its
   * init context and calls `registerInstance` from a later phase still
   * trips the stage guard — the closure reads `this.phase` at call
   * time, not at context-build time.
   */
  private phase: LifecyclePhase = 'idle';

  constructor(private readonly host: LifecycleHost) {}

  /** Run `init` on every enabled plugin in registration order. */
  public async runInit(): Promise<void> {
    this.phase = 'init';
    try {
      await this.runPhase('init', async (entry, ctx) => {
        if (entry.plugin.init !== undefined) {
          await entry.plugin.init(ctx as PluginInitContext);
        }
      });
    } finally {
      // Switch off the init guard on every path — otherwise a
      // late-resolving async tail from inside a failed init could still
      // sneak a registerInstance through.
      this.phase = 'running';
    }
  }

  /**
   * Run `start` on every enabled plugin in registration order, then
   * attach every enabled plugin's event subscriptions to the host's
   * event dispatcher.
   */
  public async runStart(): Promise<void> {
    this.phase = 'start';
    try {
      await this.runPhase('start', async (entry, ctx) => {
        if (entry.plugin.start !== undefined) {
          await entry.plugin.start(ctx as PluginStartContext);
        }
      });
    } finally {
      this.phase = 'running';
    }
    this.attachEventSubscriptions();
  }

  /** Run `onReady` on every enabled plugin in registration order. */
  public async runReady(): Promise<void> {
    this.phase = 'ready';
    try {
      await this.runPhase('onReady', async (entry, ctx) => {
        if (entry.plugin.onReady !== undefined) {
          await entry.plugin.onReady(ctx as PluginRuntimeContext);
        }
      });
    } finally {
      this.phase = 'running';
    }
  }

  /** A guild recovery failure must not disable a plugin for healthy guilds. */
  public async runGuildDatabaseReady(guildId: string): Promise<void> {
    for (const [id, entry] of this.host.registered) {
      if (this.host.disabled.has(id)) continue;
      try {
        await entry.plugin.onGuildDatabaseReady?.(this.buildRuntimeContext(entry), guildId);
      } catch (err: unknown) {
        this.host.logger.error(
          { plugin: id, guildId, err: err instanceof Error ? err : new Error(String(err)) },
          'plugin onGuildDatabaseReady threw; guild recovery may be incomplete',
        );
      }
    }
  }

  /**
   * Run `onShutdown` in reverse registration order. Failures are always
   * non-fatal — the bot is shutting down regardless.
   *
   * Disabled status does not gate either step. Disabling happens when a
   * hook throws, which is precisely when a plugin is most likely to be
   * holding a half-released resource: one disabled during `onReady` has
   * already opened whatever `start` opened (an HTTP listener, a poll
   * timer) and already has live event subscriptions. Skipping it leaked
   * both. Teardown is best-effort by contract — every `onShutdown`
   * failure is caught and logged — so running it on a plugin that never
   * got far enough to need it costs a warning at worst.
   */
  public async runShutdown(): Promise<void> {
    this.phase = 'shutdown';
    const reverse = [...this.host.registered.keys()].reverse();
    for (const id of reverse) {
      const entry = this.host.registered.get(id);
      if (entry === undefined) continue;
      if (entry.plugin.onShutdown !== undefined) {
        try {
          await entry.plugin.onShutdown(this.buildRuntimeContext(entry));
        } catch (err: unknown) {
          this.host.logger.warn(
            {
              plugin: id,
              err: err instanceof Error ? err : new Error(String(err)),
            },
            'plugin onShutdown threw; ignored',
          );
        }
      }
      this.host.dispatcher.unsubscribeAll(id);
    }
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private async runPhase(
    phase: 'init' | 'start' | 'onReady',
    invoke: (
      entry: RegisteredPlugin,
      ctx: PluginInitContext | PluginRuntimeContext,
    ) => Promise<void>,
  ): Promise<void> {
    for (const [id, entry] of this.host.registered) {
      if (this.host.disabled.has(id)) continue;
      try {
        const ctx =
          phase === 'init' ? this.buildInitContext(entry) : this.buildRuntimeContext(entry);
        await invoke(entry, ctx);
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.host.disabled.set(id, { id, phase, error });
        this.host.logger.error(
          { plugin: id, phase, err: error },
          'plugin lifecycle hook threw; plugin disabled',
        );
      }
    }
  }

  private attachEventSubscriptions(): void {
    for (const [id, entry] of this.host.registered) {
      if (this.host.disabled.has(id)) continue;
      const subs: PluginEventSubscriptions | undefined = entry.plugin.events;
      if (subs === undefined) continue;
      this.host.dispatcher.subscribe(id, this.buildRuntimeServices(entry), subs);
    }
  }

  private buildRuntimeServices(entry: RegisteredPlugin): PluginRuntimeServices {
    return Object.freeze({
      logger: this.host.logger.child({ plugin: entry.plugin.id }),
      translator: this.host.translator,
      clock: this.host.clock,
      resolve: this.host.resolve,
    });
  }

  private buildRuntimeContext(entry: RegisteredPlugin): PluginRuntimeContext {
    return this.buildRuntimeServices(entry);
  }

  private buildInitContext(entry: RegisteredPlugin): PluginInitContext {
    const pluginId = entry.plugin.id;
    // The closure captures `this` (and thereby the live `phase`) so
    // every call site reads the phase at *invocation* time. A plugin
    // that stashes the ctx and triggers registerInstance from `start`
    // therefore still fails the stage guard.
    const registerInstance: RegisterInstance = <T>(token: ServiceToken<T>, instance: T): void => {
      this.assertInitPhase(pluginId, token);
      // Wrap as a constant singleton factory so the container's existing
      // singleton cache + DuplicateRegistrationError semantics apply
      // uniformly — registerInstance is a facade, not a parallel path.
      this.host.container.registerSingleton(token, () => instance);
    };
    return Object.freeze({
      ...this.buildRuntimeServices(entry),
      registerInstance,
    });
  }

  /**
   * Stage guard for `registerInstance`. Lives on the runner — not on
   * the per-plugin context object — so the captured closure always
   * sees the *current* lifecycle phase, even if the plugin smuggled
   * the init ctx into a later hook.
   *
   * Failure raises a {@link ConfigurationError} with code
   * `'LIFECYCLE_PHASE_VIOLATION'` and the i18n key
   * `errors:plugin.lifecycle_phase_violation`. The runner's existing
   * try/catch turns this into the normal "plugin disabled" flow;
   * nothing about the error path is special-cased.
   */
  private assertInitPhase<T>(pluginId: PluginId, token: ServiceToken<T>): void {
    if (this.phase === 'init') return;
    throw new ConfigurationError({
      code: 'LIFECYCLE_PHASE_VIOLATION',
      messageKey: 'errors:plugin.lifecycle_phase_violation',
      messageParams: {
        plugin: pluginId,
        token: token.description,
        phase: this.phase,
      },
      context: {
        operation: 'PluginLifecycleRunner.registerInstance',
        pluginId,
        token: token.description,
        phase: this.phase,
      },
    });
  }
}
