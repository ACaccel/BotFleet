/**
 * Unit tests for the `PluginInitContext.registerInstance` stage guard.
 * The guard lives on `PluginLifecycleRunner` and rejects every
 * call that lands outside the synchronous body of the `init` phase.
 *
 * Each case wires a `PluginLifecycleRunner` against a real
 * `DefaultServiceContainer` and asserts:
 *   - happy path: registration during `init` succeeds and the
 *     container resolves the instance back by token reference;
 *   - duplicate-token: a second `registerInstance` for the same token
 *     surfaces `DuplicateRegistrationError` via the host's normal
 *     disable flow;
 *   - phase violations: calls smuggled into `start`, `onReady`,
 *     `onShutdown`, or an event hook each raise a `ConfigurationError`
 *     with code `'LIFECYCLE_PHASE_VIOLATION'` and the i18n key
 *     `errors:plugin.lifecycle_phase_violation`.
 */
import { describe, expect, it } from 'vitest';

import { ConfigurationError } from '../../../../src/core/errors';
import { createContainer, token } from '../../../../src/core/ioc';
import { EventDispatcher } from '../../../../src/core/plugin/event-dispatcher';
import {
  PluginLifecycleRunner,
  type LifecycleHost,
  type RegisteredPlugin,
} from '../../../../src/core/plugin/host/lifecycle';
import type {
  DisabledPlugin,
  Plugin,
  PluginId,
  PluginInitContext,
  PluginRuntimeContext,
  PluginStartContext,
} from '../../../../src/core/plugin/types';
import { systemClock } from '../../../../src/core/time';
import { DuplicateRegistrationError } from '../../../../src/core/ioc/container';
import { echoTranslator, silentLogger } from '../../../fixtures/runtime';

const silent = silentLogger();

interface TestService {
  readonly tag: string;
}
const TestServiceToken = token<TestService>('R2TestService');
const OtherToken = token<TestService>('R2OtherService');

const plugin = (p: Partial<Plugin> & { id: string }): Plugin =>
  ({ version: '1.0.0', ...p }) as Plugin;

const buildHost = (plugins: readonly Plugin[]): LifecycleHost => {
  const registered = new Map<PluginId, RegisteredPlugin>();
  for (const p of plugins) registered.set(p.id, { plugin: p });
  const container = createContainer();
  return {
    registered,
    disabled: new Map<PluginId, DisabledPlugin>(),
    resolve: container.resolve.bind(container),
    container,
    dispatcher: new EventDispatcher(silent),
    logger: silent,
    translator: echoTranslator(),
    clock: systemClock,
  };
};

describe('PluginLifecycleRunner.registerInstance stage guard', () => {
  it('publishes the instance to the container when called during init', async () => {
    const instance: TestService = { tag: 'happy' };
    const host = buildHost([
      plugin({
        id: 'p',
        init: async (ctx) => {
          (ctx as PluginInitContext).registerInstance(TestServiceToken, instance);
        },
      }),
    ]);
    const runner = new PluginLifecycleRunner(host);
    await runner.runInit();
    expect(host.disabled.has('p')).toBe(false);
    expect(host.container.resolve(TestServiceToken)).toBe(instance);
  });

  it('surfaces DuplicateRegistrationError when two plugins claim the same token', async () => {
    const a: TestService = { tag: 'a' };
    const b: TestService = { tag: 'b' };
    const host = buildHost([
      plugin({
        id: 'a',
        init: async (ctx) => {
          (ctx as PluginInitContext).registerInstance(TestServiceToken, a);
        },
      }),
      plugin({
        id: 'b',
        init: async (ctx) => {
          (ctx as PluginInitContext).registerInstance(TestServiceToken, b);
        },
      }),
    ]);
    const runner = new PluginLifecycleRunner(host);
    await runner.runInit();
    expect(host.disabled.has('a')).toBe(false);
    const failure = host.disabled.get('b');
    expect(failure).toBeDefined();
    expect(failure!.error).toBeInstanceOf(DuplicateRegistrationError);
    expect(host.container.resolve(TestServiceToken)).toBe(a);
  });

  it('throws LIFECYCLE_PHASE_VIOLATION when a stale init ctx is reused in start', async () => {
    let captured: PluginInitContext | undefined;
    const host = buildHost([
      plugin({
        id: 'p',
        init: async (ctx) => {
          captured = ctx as PluginInitContext;
        },
        start: async () => {
          captured!.registerInstance(TestServiceToken, { tag: 'late' });
        },
      }),
    ]);
    const runner = new PluginLifecycleRunner(host);
    await runner.runInit();
    expect(host.disabled.has('p')).toBe(false);
    await runner.runStart();
    const reason = host.disabled.get('p');
    expect(reason).toBeDefined();
    expect(reason!.phase).toBe('start');
    expect(reason!.error).toBeInstanceOf(ConfigurationError);
    const cfgErr = reason!.error as ConfigurationError<{
      readonly plugin: string;
      readonly token: string;
      readonly phase: string;
    }>;
    expect(cfgErr.code).toBe('LIFECYCLE_PHASE_VIOLATION');
    expect(cfgErr.messageKey).toBe('errors:plugin.lifecycle_phase_violation');
    expect(cfgErr.messageParams?.plugin).toBe('p');
    expect(cfgErr.messageParams?.token).toBe(TestServiceToken.description);
    expect(cfgErr.messageParams?.phase).toBe('start');
    expect(host.container.tryResolve(TestServiceToken)).toBeUndefined();
  });

  it('throws LIFECYCLE_PHASE_VIOLATION when the stale ctx fires in onReady', async () => {
    let captured: PluginInitContext | undefined;
    const host = buildHost([
      plugin({
        id: 'p',
        init: async (ctx) => {
          captured = ctx as PluginInitContext;
        },
        onReady: async () => {
          captured!.registerInstance(OtherToken, { tag: 'late' });
        },
      }),
    ]);
    const runner = new PluginLifecycleRunner(host);
    await runner.runInit();
    await runner.runStart();
    await runner.runReady();
    const reason = host.disabled.get('p');
    expect(reason).toBeDefined();
    expect(reason!.phase).toBe('onReady');
    expect(reason!.error).toBeInstanceOf(ConfigurationError);
    expect((reason!.error as ConfigurationError).code).toBe('LIFECYCLE_PHASE_VIOLATION');
    expect((reason!.error as ConfigurationError<{ phase: string }>).messageParams?.phase).toBe(
      'ready',
    );
  });

  it('throws LIFECYCLE_PHASE_VIOLATION when the stale ctx fires in an event hook', async () => {
    let captured: PluginInitContext | undefined;
    let observed: unknown;
    const host = buildHost([
      plugin({
        id: 'p',
        init: async (ctx) => {
          captured = ctx as PluginInitContext;
        },
        events: {
          messageCreate: async () => {
            try {
              captured!.registerInstance(OtherToken, { tag: 'late' });
            } catch (e) {
              observed = e;
            }
          },
        },
      }),
    ]);
    const runner = new PluginLifecycleRunner(host);
    await runner.runInit();
    await runner.runStart();
    // Phase is now 'running'; event hooks see this phase, not 'start'.
    // Simulate a dispatch by directly invoking the subscription via the
    // dispatcher's subscribe-side wiring would re-implement the host;
    // instead invoke the plugin's event subscription synchronously.
    const sub = (host.registered.get('p')!.plugin.events as { messageCreate: () => Promise<void> })
      .messageCreate;
    await sub();
    expect(observed).toBeInstanceOf(ConfigurationError);
    const err = observed as ConfigurationError<{ phase: string }>;
    expect(err.code).toBe('LIFECYCLE_PHASE_VIOLATION');
    expect(err.messageParams?.phase).toBe('running');
  });

  it('throws LIFECYCLE_PHASE_VIOLATION when the stale ctx fires in onShutdown', async () => {
    let captured: PluginInitContext | undefined;
    let observed: unknown;
    const host = buildHost([
      plugin({
        id: 'p',
        init: async (ctx) => {
          captured = ctx as PluginInitContext;
        },
        onShutdown: async () => {
          try {
            captured!.registerInstance(OtherToken, { tag: 'late' });
          } catch (e) {
            observed = e;
          }
        },
      }),
    ]);
    const runner = new PluginLifecycleRunner(host);
    await runner.runInit();
    await runner.runShutdown();
    expect(observed).toBeInstanceOf(ConfigurationError);
    expect((observed as ConfigurationError<{ phase: string }>).messageParams?.phase).toBe(
      'shutdown',
    );
  });

  it('switches the phase off init even when a plugin throws', async () => {
    let captured: PluginInitContext | undefined;
    const host = buildHost([
      plugin({
        id: 'thrower',
        init: async (ctx) => {
          captured = ctx as PluginInitContext;
          throw new Error('init blew up');
        },
      }),
    ]);
    const runner = new PluginLifecycleRunner(host);
    await runner.runInit();
    // After the throw, the runner must have switched the phase off
    // 'init' so a deferred async callback cannot register late.
    expect(() => captured!.registerInstance(OtherToken, { tag: 'late' })).toThrow(
      ConfigurationError,
    );
  });

  // Compile-time check: registerInstance lives only on the init
  // context. The two `@ts-expect-error` directives below are the
  // actual assertion — TypeScript fails the build if either context
  // ever sprouts the property.
  it('only exposes registerInstance on PluginInitContext (type check)', () => {
    const initCtx = {} as PluginInitContext;
    void initCtx.registerInstance;
    const startCtx = {} as PluginStartContext;
    // @ts-expect-error registerInstance is not on PluginStartContext
    void startCtx.registerInstance;
    const runtimeCtx = {} as PluginRuntimeContext;
    // @ts-expect-error registerInstance is not on PluginRuntimeContext
    void runtimeCtx.registerInstance;
    expect(true).toBe(true);
  });
});
