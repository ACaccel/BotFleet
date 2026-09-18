import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../../../src/core/logger';
import { systemClock } from '../../../../src/core/time';
import { createContainer, type ServiceContainer } from '../../../../src/core/ioc';
import {
  PluginHost,
  PluginRegistrationError,
  type Plugin,
  type PluginHostOptions,
} from '../../../../src/core/plugin';

const silent = createLogger({ level: 'silent', pretty: false });

const fakeTranslator = { t: (k: string) => k } as PluginHostOptions['translator'];

const buildHost = (): {
  host: PluginHost;
  container: ServiceContainer;
} => {
  const container = createContainer();
  return {
    container,
    host: new PluginHost({
      container,
      logger: silent,
      translator: fakeTranslator,
      clock: systemClock,
    }),
  };
};

const plugin = (p: Partial<Plugin> & { id: string }): Plugin =>
  ({
    version: '1.0.0',
    ...p,
  }) as Plugin;

describe('PluginHost.register', () => {
  it('rejects duplicate plugin ids', () => {
    const { host } = buildHost();
    host.register(plugin({ id: 'a' }));
    expect(() => host.register(plugin({ id: 'a' }))).toThrowError(PluginRegistrationError);
  });

  it('reports registration order', () => {
    const { host } = buildHost();
    host.register(plugin({ id: 'b' }));
    host.register(plugin({ id: 'a' }));
    expect(host.getOrder()).toEqual(['b', 'a']);
  });
});

/**
 * Phase-by-phase semantics (ordering, failure isolation, subscription
 * attach / detach) belong to `PluginLifecycleRunner` and are covered in
 * `host-lifecycle.test.ts` against the runner directly. What is left
 * here is the wiring assertion that only `PluginHost` can make: that it
 * hands its own registry, container and dispatcher to the runner across
 * a full boot-to-shutdown pass.
 */
describe('PluginHost lifecycle wiring', () => {
  it('drives init -> start -> onReady -> shutdown through the real host', async () => {
    const log: string[] = [];
    const handler = vi.fn(async () => undefined);
    const { host } = buildHost();
    host.register(
      plugin({
        id: 'smoke',
        init: async () => void log.push('init'),
        start: async () => void log.push('start'),
        onReady: async () => void log.push('ready'),
        onShutdown: async () => void log.push('shutdown'),
        events: { messageCreate: handler },
      }),
    );

    await host.initAll();
    await host.startAll();
    await host.readyAll();

    const dispatcher = host.getEventDispatcher();
    expect(dispatcher.listenerCount('messageCreate')).toBe(1);
    await dispatcher.emit('messageCreate', {} as never);
    expect(handler).toHaveBeenCalledTimes(1);

    await host.shutdownAll();

    expect(log).toEqual(['init', 'start', 'ready', 'shutdown']);
    expect(dispatcher.listenerCount('messageCreate')).toBe(0);
    expect(host.getDisabledPlugins()).toEqual([]);
  });
});

describe('PluginHost.guildDatabaseReady', () => {
  it('dispatches in order, isolates errors and skips disabled plugins', async () => {
    const { host } = buildHost();
    const calls: string[] = [];
    const ready = vi.fn();
    host.register(
      plugin({
        id: 'disabled',
        init: async () => {
          throw new Error('init failed');
        },
        onGuildDatabaseReady: async () => void calls.push('disabled'),
      }),
    );
    host.register(
      plugin({
        id: 'broken',
        onReady: ready,
        onGuildDatabaseReady: async (_ctx, guildId) => {
          calls.push(`broken:${guildId}`);
          throw new Error('recovery failed');
        },
      }),
    );
    host.register(
      plugin({
        id: 'healthy',
        onGuildDatabaseReady: async (ctx, guildId) => {
          expect(ctx.clock).toBe(systemClock);
          calls.push(`healthy:${guildId}`);
        },
      }),
    );
    await host.initAll();
    await host.guildDatabaseReady('g1');
    await host.guildDatabaseReady('g2');
    expect(calls).toEqual(['broken:g1', 'healthy:g1', 'broken:g2', 'healthy:g2']);
    expect(host.getDisabledPlugins().map(({ id }) => id)).toEqual(['disabled']);
    expect(ready).not.toHaveBeenCalled();
  });
});
