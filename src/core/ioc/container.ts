/**
 * Manual IoC container for BotFleet.
 *
 * Why hand-rolled and not Inversify / tsyringe / NestJS:
 *   - No reflect-metadata, no decorators, no class-emit gymnastics.
 *   - The implementation fits in this file and is debuggable in isolation.
 *   - At this project's scale a DI framework adds more surface than it
 *     removes; this module is the deliberate alternative.
 *
 * Public surface:
 *   - {@link ServiceToken} + {@link token}: typed handles with symbol
 *     identity (collision-proof) and an invariant phantom field so
 *     `ServiceToken<Dog>` is not assignable to `ServiceToken<Animal>`.
 *   - {@link Resolver}: read-only side, the only thing factories receive.
 *   - {@link ServiceContainer}: read + register, owned by composition roots.
 *
 * Singleton is the only lifetime. Every service the bot binds is
 * process-scoped, and per-guild state is reached through explicit
 * factory tokens (`ReposFactory`) rather than a container scope — one
 * line in the composition root instead of a scope object threaded
 * through the whole call graph.
 *
 * Service-locator guard:
 *   Only composition roots (`src/bot/**`) and tests are allowed to
 *   import this module. ESLint's `no-restricted-imports` enforces this so
 *   `handlers/`, `plugins/`, `persistence/`, `infra/` may not call
 *   `container.resolve()` directly — they receive dependencies via
 *   constructor parameters or the plugin host's typed resolver.
 */

/**
 * Opaque, type-safe handle for a single service binding.
 *
 * The phantom is in a function position so `T` is invariant — without
 * this, `ServiceToken<SubT>` would be structurally assignable to
 * `ServiceToken<SuperT>` and a Dog factory could be resolved through an
 * Animal token. The phantom is `?` so it never has to be set at runtime.
 */
export interface ServiceToken<T> {
  readonly symbol: symbol;
  readonly description: string;
  /** Invariance brand. Never set at runtime. */
  readonly __brand?: (value: T) => T;
}

/**
 * Construct a fresh {@link ServiceToken}. Each call mints a unique
 * `Symbol`; tokens are compared by symbol identity, not by description.
 *
 * @param description Human-readable label used in error messages and
 *   `Symbol(description)`. Pick something searchable (e.g. `'Logger'`,
 *   `'ReposFactory'`).
 */
export const token = <T>(description: string): ServiceToken<T> => ({
  symbol: Symbol(description),
  description,
});

/**
 * Read-only side of the container. Factories receive a `Resolver`, not a
 * full {@link ServiceContainer}, so they cannot accidentally register
 * extra bindings during construction (which would be order-dependent and
 * hide the dependency graph).
 */
export interface Resolver {
  /** Resolve `t` or throw {@link ServiceResolutionError}. */
  resolve<T>(t: ServiceToken<T>): T;
  /** Resolve `t` or return undefined when unbound. */
  tryResolve<T>(t: ServiceToken<T>): T | undefined;
}

type ServiceFactory<T> = (resolver: Resolver) => T;

/**
 * Register-and-resolve container. Owned by composition roots. The
 * factory runs at most once per token; the result is cached.
 */
export interface ServiceContainer extends Resolver {
  registerSingleton<T>(t: ServiceToken<T>, factory: ServiceFactory<T>): void;
}

/**
 * Thrown when {@link Resolver.resolve} is called for an unbound token.
 *
 * Carries the token description so a missing binding shows up as
 * `ServiceResolutionError: no binding for "ReposFactory"` rather than
 * the unhelpful `Symbol()` default.
 */
export class ServiceResolutionError extends Error {
  public override readonly name = 'ServiceResolutionError';
  public readonly tokenDescription: string;

  constructor(tokenDescription: string) {
    super(`ServiceResolutionError: no binding for "${tokenDescription}"`);
    this.tokenDescription = tokenDescription;
  }
}

/**
 * Thrown when {@link ServiceContainer.registerSingleton} is called twice
 * for the same token. Re-registering is almost always a programmer error
 * (two composition steps both believe they own the binding); this fails
 * loudly.
 */
export class DuplicateRegistrationError extends Error {
  public override readonly name = 'DuplicateRegistrationError';
  public readonly tokenDescription: string;

  constructor(tokenDescription: string) {
    super(
      `DuplicateRegistrationError: token "${tokenDescription}" is already registered. Re-registration is not allowed; use a separate container.`,
    );
    this.tokenDescription = tokenDescription;
  }
}

/** Default {@link ServiceContainer} implementation. */
class DefaultServiceContainer implements ServiceContainer {
  private readonly factories = new Map<symbol, ServiceFactory<unknown>>();
  private readonly cache = new Map<symbol, unknown>();

  public registerSingleton<T>(t: ServiceToken<T>, factory: ServiceFactory<T>): void {
    if (this.factories.has(t.symbol)) {
      throw new DuplicateRegistrationError(t.description);
    }
    this.factories.set(t.symbol, factory as ServiceFactory<unknown>);
  }

  public resolve<T>(t: ServiceToken<T>): T {
    const value = this.tryResolve(t);
    if (value === undefined) {
      throw new ServiceResolutionError(t.description);
    }
    return value;
  }

  public tryResolve<T>(t: ServiceToken<T>): T | undefined {
    const factory = this.factories.get(t.symbol);
    if (factory === undefined) return undefined;
    if (!this.cache.has(t.symbol)) {
      this.cache.set(t.symbol, factory(this.resolverView()));
    }
    return this.cache.get(t.symbol) as T;
  }

  /**
   * Returns a Resolver view of this container — `registerSingleton` is
   * absent at runtime, not just at compile time. Defense-in-depth
   * against `@ts-ignore`d factories.
   */
  private resolverView(): Resolver {
    return {
      resolve: this.resolve.bind(this),
      tryResolve: this.tryResolve.bind(this),
    };
  }
}

/**
 * Convenience factory for the default container. Preferred over `new`
 * at call sites so the implementation type stays an internal detail and
 * future swaps (test doubles, instrumented containers) are local.
 */
export const createContainer = (): ServiceContainer => new DefaultServiceContainer();
