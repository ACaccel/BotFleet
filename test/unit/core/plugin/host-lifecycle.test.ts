/**
 * Unit tests for PluginLifecycleRunner. Exercises each lifecycle phase
 * and the failure-isolation contract against a fake LifecycleHost — no
 * PluginHost wiring required.
 */
import { describe, expect, it } from 'vitest';
import { systemClock } from '../../../../src/core/time';
import { createContainer } from '../../../../src/core/ioc';
import { EventDispatcher } from '../../../../src/core/plugin/event-dispatcher';
import {
  PluginLifecycleRunner,
  type LifecycleHost,
  type RegisteredPlugin,
} from '../../../../src/core/plugin/host/lifecycle';
import type { DisabledPlugin, Plugin, PluginId } from '../../../../src/core/plugin/types';
import { echoTranslator, silentLogger } from '../../../fixtures/runtime';

const silent = silentLogger();

const plugin = (p: Partial<Plugin> & { id: string }): Plugin =>
  ({ version: '1.0.0', ...p }) as Plugin;

const buildHost = (plugins: readonly Plugin[]): LifecycleHost => {
  const registered = new Map<PluginId, RegisteredPlugin>();
  for (const p of plugins) registered.set(p.id, { plugin: p });
  return {
    registered,
    disabled: new Map<PluginId, DisabledPlugin>(),
    resolve: (() => {
      throw new Error('not used');
    }) as LifecycleHost['resolve'],
    container: createContainer(),
    dispatcher: new EventDispatcher(silent),
    logger: silent,
    translator: echoTranslator(),
    clock: systemClock,
  };
};

describe('PluginLifecycleRunner', () => {
  it('runs init / start / onReady hooks in registration order', async () => {
    const calls: string[] = [];
    const host = buildHost([
      plugin({
        id: 'a',
        init: async () => void calls.push('a.init'),
        start: async () => void calls.push('a.start'),
        onReady: async () => void calls.push('a.ready'),
      }),
      plugin({
        id: 'b',
        init: async () => void calls.push('b.init'),
      }),
    ]);
    const runner = new PluginLifecycleRunner(host);
    await runner.runInit();
    await runner.runStart();
    await runner.runReady();
    expect(calls).toEqual(['a.init', 'b.init', 'a.start', 'a.ready']);
  });

  it('disables a plugin that throws and continues the phase', async () => {
    const calls: string[] = [];
    const host = buildHost([
      plugin({
        id: 'a',
        init: async () => {
          throw new Error('boom');
        },
      }),
      plugin({ id: 'b', init: async () => void calls.push('b.init') }),
    ]);
    const runner = new PluginLifecycleRunner(host);
    await runner.runInit();
    expect(host.disabled.has('a')).toBe(true);
    expect(calls).toEqual(['b.init']);
  });

  it('runs onShutdown in reverse order and swallows shutdown failures', async () => {
    const calls: string[] = [];
    const host = buildHost([
      plugin({ id: 'a', onShutdown: async () => void calls.push('a.shutdown') }),
      plugin({
        id: 'b',
        onShutdown: async () => {
          throw new Error('shutdown boom');
        },
      }),
    ]);
    const runner = new PluginLifecycleRunner(host);
    await expect(runner.runShutdown()).resolves.toBeUndefined();
    expect(calls).toEqual(['a.shutdown']);
  });

  it('still tears down a plugin disabled after start completed', async () => {
    const calls: string[] = [];
    const host = buildHost([
      plugin({
        id: 'a',
        start: async () => void calls.push('a.start'),
        onReady: async () => {
          throw new Error('ready boom');
        },
        onShutdown: async () => void calls.push('a.shutdown'),
      }),
    ]);
    const runner = new PluginLifecycleRunner(host);
    await runner.runStart();
    await runner.runReady();
    expect(host.disabled.has('a')).toBe(true);

    await runner.runShutdown();
    // `start` already opened whatever the plugin owns (a listener, a
    // timer); skipping teardown by disabled status leaked it.
    expect(calls).toEqual(['a.start', 'a.shutdown']);
  });

  it('never subscribes a plugin whose init threw', async () => {
    // The invariant every plugin that resolves its dependencies in
    // `init` relies on (see the `init` contract in core/plugin/types.ts):
    // a failed init means no event can ever reach the subscription, which
    // is what lets those subscriptions treat init-assigned state as
    // present and raise instead of degrading when it is not.
    const host = buildHost([
      plugin({
        id: 'a',
        init: async () => {
          throw new Error('init boom');
        },
        events: { messageCreate: async () => undefined },
      }),
      plugin({ id: 'b', events: { messageCreate: async () => undefined } }),
    ]);
    const runner = new PluginLifecycleRunner(host);

    await runner.runInit();
    await runner.runStart();

    expect(host.disabled.has('a')).toBe(true);
    // Only the healthy plugin's subscription is attached.
    expect(host.dispatcher.listenerCount('messageCreate')).toBe(1);
  });

  it('detaches event subscriptions for a plugin disabled after it subscribed', async () => {
    const host = buildHost([
      plugin({
        id: 'a',
        events: { messageCreate: async () => undefined },
        onReady: async () => {
          throw new Error('ready boom');
        },
      }),
    ]);
    const runner = new PluginLifecycleRunner(host);
    await runner.runStart();
    expect(host.dispatcher.listenerCount('messageCreate')).toBe(1);

    await runner.runReady();
    await runner.runShutdown();

    expect(host.dispatcher.listenerCount('messageCreate')).toBe(0);
  });
});
