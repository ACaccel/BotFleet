/**
 * Plugin contract — types only.
 *
 * This file declares the interfaces every plugin and the
 * {@link PluginHost} agree on. No runtime logic here — see `host.ts`,
 * `event-dispatcher.ts`, `interaction-router.ts`.
 *
 * Design pillars (the host enforces every one):
 *   - **id + version** identify the plugin. Ids are unique per host;
 *     a duplicate fails at register time (cheap, clearest diagnostic,
 *     lifecycle has not yet started).
 *   - **Lifecycle hooks** are all optional `async () => void` and run
 *     in registration order: `init` -> `start` -> `onReady` ->
 *     ... runtime ... -> `onShutdown` (reverse registration order).
 *   - **events** are a typed subscription map over `discord.js`'s
 *     `ClientEvents`. The {@link EventDispatcher} fans events out with
 *     per-subscription `Promise.allSettled` isolation.
 *   - **Failure isolation**: a hook that throws marks the plugin
 *     {@link DisabledPlugin} and the rest of the bot keeps running.
 *
 * Configuration is *not* part of this contract. Each plugin factory
 * parses its own raw config (`parse<X>Config`) at composition time and
 * captures the result in the returned object's closure, so a malformed
 * block fails the boot rather than the first event.
 *
 * Handler registration is *not* part of this contract either. The
 * codegen registries under `src/handlers/<type>/registry.generated.ts`
 * are the single registration mechanism.
 *
 * Service-locator guard: plugins do **not** receive the raw IoC
 * container. {@link PluginInitContext.resolve} is a typed-token
 * accessor; combined with eslint's `no-restricted-imports` blocking
 * `core/ioc` from layered code, plugins cannot bypass DI.
 */
import type { ClientEvents, Interaction } from 'discord.js';

import type { Logger } from '../logger';
import type { Translator } from '../i18n';
import type { Clock } from '../time';
import type { ServiceToken } from '../ioc';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Globally unique plugin identifier. Snake-case or kebab-case by convention. */
export type PluginId = string;

/** Semver string. Major bumps for breaking contract changes. */
export type PluginVersion = string;

// ---------------------------------------------------------------------------
// Lifecycle contexts
// ---------------------------------------------------------------------------

/** Typed token-based resolve. Tighter than handing out the full container. */
export type TypedResolver = <T>(token: ServiceToken<T>) => T;

/**
 * Shared bindings every lifecycle context carries. The plugin gets a
 * pre-scoped child logger, the translator, a clock for any time math,
 * and a typed `resolve` for its dependencies. No raw container, no
 * string-keyed lookups.
 */
export interface PluginRuntimeServices {
  readonly logger: Logger;
  readonly translator: Translator;
  readonly clock: Clock;
  readonly resolve: TypedResolver;
}

/**
 * Narrow write surface handed to a plugin's `init` hook. Allows the
 * plugin to publish a pre-built instance under a typed token so the
 * rest of the bot can resolve it through normal DI instead of a
 * module-scope holder, keeping all wiring on the typed DI path.
 *
 * Legal **only inside `init`**. The host's lifecycle runner captures
 * the current phase in a closure when it builds the init context, so a
 * plugin that stashes the context object and calls `registerInstance`
 * later (from `start`, `onReady`, `onShutdown`, an event hook, a
 * scheduled job, or an interaction handler) still trips the guard and
 * receives a {@link ConfigurationError} with code
 * `'LIFECYCLE_PHASE_VIOLATION'`. Type-level: the other lifecycle
 * contexts deliberately omit this method, so the obvious misuses do
 * not even compile.
 *
 * Idempotency: re-registering the same token in the same init pass
 * (or across two plugins) surfaces the container's existing
 * `DuplicateRegistrationError`. The host does not catch and rephrase
 * it — a token collision is a composition bug, not a runtime error.
 *
 * Width: only register a *built* instance. Factories and lazy
 * singletons are deliberately not exposed; opening that surface would
 * turn `PluginContext` into a service-locator registrar, which the
 * plugin contract docstring (`types.ts` header) explicitly forbids.
 */
export type RegisterInstance = <T>(token: ServiceToken<T>, instance: T) => void;

/** Context handed to `Plugin.init`. */
export interface PluginInitContext extends PluginRuntimeServices {
  /**
   * Publish a pre-built instance under a typed token. See
   * {@link RegisterInstance} for the full contract. Calling this
   * outside the synchronous body of `init` throws.
   */
  readonly registerInstance: RegisterInstance;
}

/** Context handed to `Plugin.start` (Discord login done, ready event pending). */
export type PluginStartContext = PluginRuntimeServices;

/** Context handed to runtime lifecycle hooks. */
export type PluginRuntimeContext = PluginRuntimeServices;

/** Context handed to event subscriptions per dispatch. */
export interface PluginEventContext extends PluginRuntimeServices {
  /** Discord event name being dispatched. */
  readonly eventName: keyof ClientEvents;
}

// ---------------------------------------------------------------------------
// Event subscriptions (typed over discord.js ClientEvents)
// ---------------------------------------------------------------------------

/**
 * Subscription map keyed by `discord.js` event names. Each subscription
 * receives the plugin's runtime context plus the event's positional
 * arguments verbatim.
 */
export type PluginEventSubscriptions = {
  readonly [K in keyof ClientEvents]?: (
    ctx: PluginEventContext,
    ...args: ClientEvents[K]
  ) => Promise<void> | void;
};

// ---------------------------------------------------------------------------
// Plugin contract
// ---------------------------------------------------------------------------

export interface Plugin {
  readonly id: PluginId;
  readonly version: PluginVersion;

  /**
   * One-shot setup. Runs before Discord login. Throw to mark this
   * plugin disabled; the rest of the bot keeps running.
   *
   * `init` is where a plugin resolves its dependencies — once, into
   * state the {@link events} closures read — rather than per event. The
   * host attaches event subscriptions only for plugins whose `init`
   * succeeded, so a subscription may treat that state as present. When
   * it is not, **raise**: the dispatcher isolates and logs the throw per
   * subscriber, whereas returning quietly leaves a plugin that looks
   * alive and does nothing.
   */
  init?(ctx: PluginInitContext): Promise<void>;

  /**
   * Runs after Discord login succeeds but before the `ready` event
   * fires. Use to attach low-frequency listeners or bind a port. Same
   * error semantics as `init`.
   */
  start?(ctx: PluginStartContext): Promise<void>;

  /** Runs once after the Discord `ready` event. */
  onReady?(ctx: PluginRuntimeContext): Promise<void>;

  /** Rebuild guild-scoped state after a previously unavailable database connects. */
  onGuildDatabaseReady?(ctx: PluginRuntimeContext, guildId: string): Promise<void>;

  /**
   * Runs during graceful shutdown — in **reverse** registration order,
   * so a plugin registered later stops before the ones it was layered
   * on top of. Failure here is logged but does not block other
   * plugins' shutdown.
   *
   * **May run without a successful `init` / `start`.** Disabled status
   * does not skip teardown: a plugin disabled during `onReady` still
   * holds whatever `start` opened, and skipping it leaked exactly
   * those resources. The hook must therefore tolerate un-initialised
   * state — guard the fields your `init` assigns rather than assuming
   * they exist.
   */
  onShutdown?(ctx: PluginRuntimeContext): Promise<void>;

  /** Discord event subscriptions, fanned out by {@link EventDispatcher}. */
  readonly events?: PluginEventSubscriptions;
}

// ---------------------------------------------------------------------------
// InteractionRouter middleware
// ---------------------------------------------------------------------------

/**
 * Context threaded through the InteractionRouter middleware chain.
 * Carries the raw Discord `Interaction` plus a request-scoped logger
 * with `traceId` already bound. Middleware is free to add fields by
 * augmenting `state`.
 */
export interface InteractionContext extends PluginRuntimeServices {
  readonly interaction: Interaction;
  /** Stable per-interaction id; child of `logger` already binds this. */
  readonly traceId: string;
  /** Mutable bag for middleware-to-middleware coordination. */
  readonly state: Map<string, unknown>;
}

/**
 * Express-style middleware. Implementations either call `next()` to
 * advance the chain or short-circuit by not calling it.
 *
 * `name` is mandatory: log lines and error traces cite it; a middleware
 * stack with anonymous functions is unobservable in production.
 */
export interface InteractionMiddleware {
  readonly name: string;
  run(ctx: InteractionContext, next: () => Promise<void>): Promise<void>;
}

// ---------------------------------------------------------------------------
// Host-side reporting
// ---------------------------------------------------------------------------

/**
 * Reason a plugin entered the disabled set. Captures everything an
 * operator needs to triage from `/health` output or startup logs.
 */
export interface DisabledPlugin {
  readonly id: PluginId;
  /** Lifecycle phase where the failure surfaced. */
  readonly phase: 'register' | 'init' | 'start' | 'onReady';
  readonly error: Error;
}
