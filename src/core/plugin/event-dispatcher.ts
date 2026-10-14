/**
 * Observer / event-bus that fans Discord events out to plugin subscriptions
 * with per-subscription error isolation.
 *
 * Design contract:
 *   - One plugin's `events[MessageCreate]` throwing MUST NOT abort other
 *     plugins' subscriptions to the same event (`Promise.allSettled` over
 *     the subscriber list).
 *   - Per-subscription errors are logged with `plugin`, `event`, `err`
 *     fields. Critical-plugin escalation is NOT done here: the host's
 *     `init`/`start` hooks own that decision; event-time failures are always
 *     non-fatal.
 *   - Constructible without a Discord `Client`; tests drive it via `emit()`.
 */
import type { ClientEvents } from 'discord.js';
import type { Logger } from '../logger';
import type {
  PluginEventContext,
  PluginEventSubscriptions,
  PluginId,
  PluginRuntimeServices,
} from './types';

interface Subscription<K extends keyof ClientEvents> {
  readonly pluginId: PluginId;
  readonly handler: NonNullable<PluginEventSubscriptions[K]>;
  readonly services: PluginRuntimeServices;
}

export class EventDispatcher {
  /**
   * Map keyed by Discord event name. Stored as a generic `Map<string, ...>`
   * internally because TypeScript cannot index a discriminated map by
   * a narrowed event key without distributing the union; callers go
   * through the typed `subscribe` / `emit` surface.
   */
  private readonly subscriptions = new Map<string, Subscription<keyof ClientEvents>[]>();

  constructor(private readonly logger: Logger) {}

  /**
   * Register a plugin's full event-subscription map. Idempotent across
   * different plugins; calling twice for the same plugin appends a
   * second subscription (the host avoids this in practice).
   */
  public subscribe(
    pluginId: PluginId,
    services: PluginRuntimeServices,
    subscriptions: PluginEventSubscriptions,
  ): void {
    for (const [event, handler] of Object.entries(subscriptions) as Array<
      [keyof ClientEvents, NonNullable<PluginEventSubscriptions[keyof ClientEvents]>]
    >) {
      const list = this.subscriptions.get(event) ?? [];
      list.push({ pluginId, handler, services } as Subscription<keyof ClientEvents>);
      this.subscriptions.set(event, list);
    }
  }

  /** Remove every subscription owned by `pluginId`. Used during shutdown. */
  public unsubscribeAll(pluginId: PluginId): void {
    for (const [event, list] of this.subscriptions) {
      const filtered = list.filter((s) => s.pluginId !== pluginId);
      if (filtered.length === 0) {
        this.subscriptions.delete(event);
      } else {
        this.subscriptions.set(event, filtered);
      }
    }
  }

  /**
   * Fan an event out to every subscriber. Each subscriber runs in
   * isolation: any throw / reject is logged and the remaining
   * subscribers still execute. Returns once every settled.
   */
  public async emit<K extends keyof ClientEvents>(
    event: K,
    ...args: ClientEvents[K]
  ): Promise<void> {
    const list = this.subscriptions.get(event);
    if (list === undefined || list.length === 0) return;

    const results = await Promise.allSettled(
      list.map((sub) => {
        const ctx: PluginEventContext = { ...sub.services, eventName: event };
        // Cast: TS cannot narrow `sub.handler` against the union key
        // automatically. The subscribe contract guarantees the handler
        // matches the event's argument shape.
        const handler = sub.handler as (
          c: PluginEventContext,
          ...a: ClientEvents[K]
        ) => Promise<void> | void;
        return Promise.resolve().then(() => handler(ctx, ...args));
      }),
    );

    results.forEach((result, idx) => {
      if (result.status === 'rejected') {
        const sub = list[idx];
        if (sub !== undefined) {
          this.logger.error(
            {
              event,
              plugin: sub.pluginId,
              err:
                result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
            },
            'event subscription threw; remaining subscribers were not affected',
          );
        }
      }
    });
  }

  /** Internal: count subscriptions for `event`. Test-friendly. */
  public listenerCount(event: keyof ClientEvents): number {
    return this.subscriptions.get(event)?.length ?? 0;
  }

  /**
   * Snapshot of every event name that currently has at least one
   * subscriber. BaseBot uses this after `startAll()` to attach a
   * single `client.on(event, ...)` per subscribed event, forwarding
   * into {@link emit}. Returning a fresh array keeps the caller from
   * mutating the dispatcher's internal map.
   */
  public subscribedEvents(): readonly (keyof ClientEvents)[] {
    return [...this.subscriptions.keys()] as (keyof ClientEvents)[];
  }
}
