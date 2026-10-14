/**
 * Shared stand-ins for the core runtime services every layer receives:
 * translator, logger and the plugin lifecycle contexts.
 *
 * These were re-implemented inline in dozens of suites, each with its
 * own cast. The fixtures own the casts so a change to `Translator`,
 * `Logger` or the plugin context types is absorbed in one file.
 */
import type { ClientEvents } from 'discord.js';
import { vi, type Mock } from 'vitest';

import type { Translator } from '../../src/core/i18n';
import type { ServiceToken } from '../../src/core/ioc';
import { createLogger, type Logger } from '../../src/core/logger';
import type {
  PluginEventContext,
  PluginInitContext,
  RegisterInstance,
  TypedResolver,
} from '../../src/core/plugin';
import { systemClock, type Clock } from '../../src/core/time';

/**
 * Translator that returns the key unchanged. Use it when the assertion
 * is "which key did the code pick"; interpolation is not part of that
 * question. `listMissingKeys` reports nothing missing.
 */
export const echoTranslator = (): Translator => ({
  t: (key) => key,
  tStrict: (key) => key,
  listMissingKeys: () => ({ en: [], 'zh-TW': [] }),
});

/**
 * Real logger at the `silent` level: the full `Logger` contract
 * (including `child`) with no output. Use a spy logger instead when the
 * test asserts on what was logged.
 */
export const silentLogger = (): Logger => createLogger({ level: 'silent', pretty: false });

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** A {@link Logger} whose every level is a spy. */
export type SpyLogger = Logger & { readonly [Level in LogLevel]: Mock };

/**
 * Spy logger for tests that assert what was logged. `child` returns the
 * logger itself so calls made through a scoped child (`logger.child({
 * guildId })`) still land on the same spies.
 */
export const spyLogger = (): SpyLogger => {
  const logger: SpyLogger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => logger,
  };
  return logger;
};

interface PluginContextOptions {
  /**
   * Bindings answered by `resolve`; an unbound token throws. `any`
   * because `ServiceToken<T>` is invariant, so no concrete token is
   * assignable to `ServiceToken<unknown>`.
   */
  readonly services?: ReadonlyArray<readonly [ServiceToken<any>, unknown]>;
  /** Replaces the map-backed resolver, e.g. with a real container's. */
  readonly resolve?: TypedResolver;
  readonly logger?: Logger;
  readonly translator?: Translator;
  readonly clock?: Clock;
  readonly eventName?: keyof ClientEvents;
  readonly registerInstance?: RegisterInstance;
}

/**
 * Build one object that satisfies every plugin lifecycle context
 * (`init`, `start`, runtime and event). Defaults: silent logger, echo
 * translator, system clock, `messageCreate` event, and a
 * `registerInstance` that throws so an unexpected publish is visible.
 */
export const buildPluginContext = (
  options: PluginContextOptions = {},
): PluginInitContext & PluginEventContext => {
  const bindings = new Map(options.services?.map(([key, value]) => [key.symbol, value]));
  const resolveFromBindings: TypedResolver = <T>(key: ServiceToken<T>): T => {
    if (!bindings.has(key.symbol)) {
      throw new Error(`buildPluginContext: unbound token ${key.description}`);
    }
    return bindings.get(key.symbol) as T;
  };
  return {
    logger: options.logger ?? silentLogger(),
    translator: options.translator ?? echoTranslator(),
    clock: options.clock ?? systemClock,
    resolve: options.resolve ?? resolveFromBindings,
    eventName: options.eventName ?? 'messageCreate',
    registerInstance:
      options.registerInstance ??
      ((key) => {
        throw new Error(`buildPluginContext: unexpected registerInstance(${key.description})`);
      }),
  };
};
