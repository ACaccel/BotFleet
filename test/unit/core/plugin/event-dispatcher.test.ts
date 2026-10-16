import { describe, expect, it, vi } from 'vitest';
import { EventDispatcher } from '../../../../src/core/plugin/event-dispatcher';
import { createContainer } from '../../../../src/core/ioc';
import type { PluginRuntimeServices } from '../../../../src/core/plugin';
import { buildPluginContext, silentLogger } from '../../../fixtures/runtime';

const silent = silentLogger();

const services = (): PluginRuntimeServices => {
  // One container per call — `bind` target must match the method
  // owner. Tests never exercise resolve, but the wiring is still
  // shape-correct.
  const container = createContainer();
  return buildPluginContext({ logger: silent, resolve: container.resolve.bind(container) });
};

describe('EventDispatcher', () => {
  it('fans an event out to every subscriber once', async () => {
    const aFn = vi.fn(async () => undefined);
    const bFn = vi.fn(async () => undefined);
    const dispatcher = new EventDispatcher(silent);
    dispatcher.subscribe('pluginA', services(), { messageCreate: aFn });
    dispatcher.subscribe('pluginB', services(), { messageCreate: bFn });

    await dispatcher.emit('messageCreate', { content: 'hi' } as never);
    expect(aFn).toHaveBeenCalledTimes(1);
    expect(bFn).toHaveBeenCalledTimes(1);
  });

  it('isolates subscriber failures — one throw does not block siblings', async () => {
    const failing = vi.fn(async () => {
      throw new Error('A boom');
    });
    const ok = vi.fn(async () => undefined);
    const dispatcher = new EventDispatcher(silent);
    dispatcher.subscribe('pluginA', services(), { messageCreate: failing });
    dispatcher.subscribe('pluginB', services(), { messageCreate: ok });

    await dispatcher.emit('messageCreate', {} as never);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('does not throw out of emit() when a subscription rejects', async () => {
    const dispatcher = new EventDispatcher(silent);
    dispatcher.subscribe('pluginA', services(), {
      messageCreate: async () => {
        throw new Error('boom');
      },
    });
    await expect(dispatcher.emit('messageCreate', {} as never)).resolves.toBeUndefined();
  });

  it("reflects the plugin's scoped services as the subscription ctx", async () => {
    const dispatcher = new EventDispatcher(silent);
    let observedEventName: string | undefined;
    dispatcher.subscribe('p', services(), {
      ready: async (ctx) => {
        observedEventName = ctx.eventName;
      },
    });
    await dispatcher.emit('ready', {} as never);
    expect(observedEventName).toBe('ready');
  });

  it('unsubscribeAll removes every subscription owned by the plugin', async () => {
    const dispatcher = new EventDispatcher(silent);
    const stay = vi.fn(async () => undefined);
    const go = vi.fn(async () => undefined);
    dispatcher.subscribe('keep', services(), { messageCreate: stay });
    dispatcher.subscribe('drop', services(), { messageCreate: go });
    dispatcher.unsubscribeAll('drop');
    await dispatcher.emit('messageCreate', {} as never);
    expect(stay).toHaveBeenCalledTimes(1);
    expect(go).not.toHaveBeenCalled();
    expect(dispatcher.listenerCount('messageCreate')).toBe(1);
  });

  it('emit() on an event with no subscribers is a quiet no-op', async () => {
    const dispatcher = new EventDispatcher(silent);
    await expect(dispatcher.emit('messageCreate', {} as never)).resolves.toBeUndefined();
  });

  it('subscribedEvents() snapshots every event that currently has a subscriber', () => {
    const dispatcher = new EventDispatcher(silent);
    expect(dispatcher.subscribedEvents()).toEqual([]);
    dispatcher.subscribe('p1', services(), {
      messageCreate: async () => undefined,
      ready: async () => undefined,
    });
    dispatcher.subscribe('p2', services(), { messageCreate: async () => undefined });
    const events = [...dispatcher.subscribedEvents()].sort();
    expect(events).toEqual(['messageCreate', 'ready']);
    dispatcher.unsubscribeAll('p1');
    // p2 still owns messageCreate; ready has no subscribers and drops out.
    expect([...dispatcher.subscribedEvents()].sort()).toEqual(['messageCreate']);
  });
});
