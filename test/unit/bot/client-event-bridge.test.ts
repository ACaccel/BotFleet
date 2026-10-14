/**
 * Unit tests for {@link ClientEventBridge}, the collaborator BaseBot
 * composes to fan Discord raw events out to handlers. Covers:
 *   1. attach wires InteractionCreate; firing routes through router
 *   2. double attach throws (contract violation — TypeError)
 *   3. detach removes every installed listener
 *   4. GuildCreate skipped when a plugin already subscribes;
 *      otherwise routed through GuildOnboardingPort
 *   5. EventDispatcher-subscribed events are forwarded onto client.on
 *      (the dispatcher's per-subscription isolation is its own concern)
 *   6. router throw → fallback reply with traceId
 *   7. sendRebootMessages is best-effort over guildInfo
 */
import { Events } from 'discord.js';
import type { Channel, Client, ClientEvents, Guild } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { ClientEventBridge } from '../../../src/bot/client-event-bridge';
import { ThreadModeration } from '../../../src/bot/thread-moderation';
import type { GuildInfo } from '../../../src/bot/index';
import { createContainer } from '../../../src/core/ioc';
import { TOKENS } from '../../../src/bot/tokens';
import { createLogger } from '../../../src/core/logger';
import { systemClock } from '../../../src/core/time';
import { ok } from '../../../src/core/result';
import type {
  GuildOnboardingPort,
  InteractionContext,
  InteractionRouter,
  PluginHost,
} from '../../../src/core/plugin';

const silent = createLogger({ level: 'silent', pretty: false });

interface FakeClientHandle {
  readonly client: Client;
  readonly listeners: Map<string, Array<(...args: unknown[]) => unknown>>;
  fire<K extends keyof ClientEvents>(event: K, ...args: unknown[]): Promise<void>;
}

const buildFakeClient = (): FakeClientHandle => {
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const append = (event: string, fn: (...args: unknown[]) => unknown): void => {
    const arr = listeners.get(event) ?? [];
    arr.push(fn);
    listeners.set(event, arr);
  };
  const client = {
    user: { id: 'bot-1' },
    guilds: { cache: new Map() },
    channels: { cache: new Map() },
    on: (event: string, fn: (...args: unknown[]) => unknown) => {
      append(event, fn);
      return client;
    },
    off: (event: string, fn: (...args: unknown[]) => unknown) => {
      const arr = listeners.get(event);
      if (arr === undefined) return client;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
      return client;
    },
  } as unknown as Client;
  return {
    client,
    listeners,
    async fire(event, ...args) {
      for (const fn of [...(listeners.get(event) ?? [])]) {
        await fn(...args);
      }
    },
  };
};

const fakeHost = (subscribed: readonly (keyof ClientEvents)[] = []): PluginHost =>
  ({
    getEventDispatcher: () => ({
      subscribedEvents: () => subscribed,
      emit: vi.fn(async () => {}),
    }),
  }) as unknown as PluginHost;

const fakeRouter = (dispatch = vi.fn(async () => {})): InteractionRouter =>
  ({ dispatch }) as unknown as InteractionRouter;

const identityTranslator = {
  t: (key: string, params?: Record<string, string>) =>
    params !== undefined ? `${key}|${JSON.stringify(params)}` : key,
} as unknown as InteractionContext['translator'];

const baseConfig = (overrides: {
  host?: PluginHost;
  router?: InteractionRouter | undefined;
  guildInfo?: ReadonlyMap<string, GuildInfo>;
  suppression?: { interaction?: boolean; guildCreate?: boolean };
  onboardingPort?: GuildOnboardingPort;
  skipTranslator?: boolean;
}) => {
  const container = createContainer();
  container.registerSingleton(TOKENS.Logger, () => silent);
  container.registerSingleton(TOKENS.Clock, () => systemClock);
  if (overrides.skipTranslator !== true) {
    container.registerSingleton(TOKENS.Translator, () => identityTranslator);
  }
  if (overrides.onboardingPort !== undefined) {
    container.registerSingleton(
      TOKENS.GuildOnboardingPort,
      () => overrides.onboardingPort as GuildOnboardingPort,
    );
  }
  return {
    container,
    host: overrides.host ?? fakeHost(),
    router: overrides.router,
    guildInfo: () => overrides.guildInfo ?? new Map<string, GuildInfo>(),
    suppression: overrides.suppression,
  };
};

describe('ClientEventBridge.attach', () => {
  it('wires InteractionCreate and routes the event through the router', async () => {
    const fake = buildFakeClient();
    const dispatch = vi.fn(async () => {});
    const bridge = new ClientEventBridge(fake.client, silent);
    bridge.attach(baseConfig({ router: fakeRouter(dispatch) }));

    expect(fake.listeners.get(Events.InteractionCreate)?.length).toBe(1);
    expect(fake.listeners.has(Events.MessageReactionAdd)).toBe(false);
    expect(fake.listeners.has(Events.MessageReactionRemove)).toBe(false);
    const fakeInteraction = {
      isAutocomplete: () => false,
      isRepliable: () => true,
      isChatInputCommand: () => false,
      isContextMenuCommand: () => false,
      isModalSubmit: () => false,
      isButton: () => false,
      isStringSelectMenu: () => false,
      guildId: 'g-1',
      reply: async () => {},
    };
    await fake.fire(Events.InteractionCreate, fakeInteraction);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('throws TypeError on a second attach without an intervening detach', () => {
    const fake = buildFakeClient();
    const bridge = new ClientEventBridge(fake.client, silent);
    bridge.attach(baseConfig({}));
    expect(() => bridge.attach(baseConfig({}))).toThrow(TypeError);
  });

  it('does not install suppressed listeners', () => {
    const fake = buildFakeClient();
    const bridge = new ClientEventBridge(fake.client, silent);
    bridge.attach(
      baseConfig({
        suppression: { interaction: true, guildCreate: true },
      }),
    );
    expect(fake.listeners.get(Events.InteractionCreate)?.length ?? 0).toBe(0);
    expect(fake.listeners.get(Events.GuildCreate)?.length ?? 0).toBe(0);
  });
});

describe('ClientEventBridge.detach', () => {
  it('removes every listener installed by attach', () => {
    const fake = buildFakeClient();
    const bridge = new ClientEventBridge(fake.client, silent);
    bridge.attach(baseConfig({}));
    expect((fake.listeners.get(Events.InteractionCreate) ?? []).length).toBeGreaterThan(0);
    bridge.detach();
    for (const arr of fake.listeners.values()) {
      expect(arr.length).toBe(0);
    }
  });

  it('is safe to call without a prior attach', () => {
    const fake = buildFakeClient();
    const bridge = new ClientEventBridge(fake.client, silent);
    expect(() => bridge.detach()).not.toThrow();
  });
});

describe('ClientEventBridge GuildCreate routing', () => {
  it('skips the fallback listener when a plugin already subscribes', () => {
    const fake = buildFakeClient();
    const bridge = new ClientEventBridge(fake.client, silent);
    bridge.attach(baseConfig({ host: fakeHost([Events.GuildCreate]) }));

    // Exactly one listener exists, and it is the dispatcher forwarder
    // (not BaseBot's onboarding fallback).
    expect(fake.listeners.get(Events.GuildCreate)?.length).toBe(1);
  });

  it('routes GuildCreate through GuildOnboardingPort when no plugin owns it', async () => {
    const fake = buildFakeClient();
    const onboardGuild = vi.fn(async () => ({
      guildId: 'g-9',
      databaseConnected: false,
      commandsRegistered: false,
    }));
    const bridge = new ClientEventBridge(fake.client, silent);
    bridge.attach(baseConfig({ onboardingPort: { onboardGuild } }));

    await fake.fire(Events.GuildCreate, { id: 'g-9' } as Guild);
    expect(onboardGuild).toHaveBeenCalledWith('g-9');
  });
});

describe('ClientEventBridge dispatcher forwarding', () => {
  it('installs one client.on per dispatcher-subscribed event', () => {
    const fake = buildFakeClient();
    const bridge = new ClientEventBridge(fake.client, silent);
    bridge.attach(baseConfig({ host: fakeHost([Events.MessageDelete, Events.GuildMemberUpdate]) }));

    expect(fake.listeners.get(Events.MessageDelete)?.length).toBe(1);
    expect(fake.listeners.get(Events.GuildMemberUpdate)?.length).toBe(1);
  });
});

describe('ClientEventBridge interaction error path', () => {
  it('falls back to a translated reply when the router throws', async () => {
    const fake = buildFakeClient();
    const dispatch = vi.fn(async () => {
      throw new Error('handler boom');
    });
    const replies: Array<{ content?: string }> = [];
    const bridge = new ClientEventBridge(fake.client, silent);
    bridge.attach(baseConfig({ router: fakeRouter(dispatch) }));
    // Register a translator on the container so the bridge can pick a
    // localised fallback content.
    const fakeInteraction = {
      isAutocomplete: () => false,
      isRepliable: () => true,
      isChatInputCommand: () => false,
      isContextMenuCommand: () => false,
      isModalSubmit: () => false,
      isButton: () => false,
      isStringSelectMenu: () => false,
      guildId: 'g-1',
      deferred: false,
      replied: false,
      reply: async (opts: { content?: string }) => {
        replies.push(opts);
      },
      followUp: async (opts: { content?: string }) => {
        replies.push(opts);
      },
    };
    await fake.fire(Events.InteractionCreate, fakeInteraction);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(replies.length).toBe(1);
    expect(replies[0]?.content).toMatch(/errors:unexpected/);
  });
});

describe('ClientEventBridge.sendRebootMessages', () => {
  it('sends to every sendable debug channel and swallows per-guild failures', async () => {
    const fake = buildFakeClient();
    const sends: string[] = [];
    const sendable = {
      isSendable: () => true,
      send: async (msg: string) => {
        sends.push(msg);
      },
    } as unknown as Channel;
    const failing = {
      isSendable: () => true,
      send: async () => {
        throw new Error('discord 403');
      },
    } as unknown as Channel;
    const unsendable = { isSendable: () => false } as unknown as Channel;
    const guildInfo = new Map<string, GuildInfo>([
      [
        'g-ok',
        {
          bot_name: 'Botty',
          guild: { id: 'g-ok' } as Guild,
          channels: { debug: sendable },
        },
      ],
      [
        'g-fail',
        {
          bot_name: 'Botty',
          guild: { id: 'g-fail' } as Guild,
          channels: { debug: failing },
        },
      ],
      [
        'g-skip',
        {
          bot_name: 'Botty',
          guild: { id: 'g-skip' } as Guild,
          channels: { debug: unsendable },
        },
      ],
    ]);
    const bridge = new ClientEventBridge(fake.client, silent);
    bridge.attach(baseConfig({ guildInfo }));
    const translator = {
      t: (key: string, params?: Record<string, string>) =>
        params !== undefined ? `${key}|${params.botName}` : key,
    } as unknown as InteractionContext['translator'];

    await expect(bridge.sendRebootMessages(translator)).resolves.toBeUndefined();
    expect(sends.length).toBe(1);
    expect(sends[0]).toContain('replies:base_bot.reboot_notice');
  });
});

describe('ClientEventBridge thread moderation', () => {
  const moderatedMessage = () => ({
    id: 'message',
    guildId: 'guild',
    channel: { id: 'thread', ownerId: 'owner', isThread: () => true },
    author: { id: 'blocked-user', bot: false },
    partial: false,
    delete: vi.fn(async () => {}),
  });

  const moderation = () =>
    new ThreadModeration({
      botId: 'bot',
      logger: silent,
      translator: identityTranslator,
      isAdmin: () => false,
      getRepo: () => ({
        recordMessageSource: async () => ok(undefined),
        findMessageSource: async () => ok(undefined),
        listBlocked: async () => ok([]),
        isBlocked: async () => ok(true),
        setBlocked: async () => ok(undefined),
      }),
    });

  const observedHost = (subscribed: readonly (keyof ClientEvents)[]) => {
    const emit = vi.fn(async () => {});
    const host = {
      getEventDispatcher: () => ({ subscribedEvents: () => subscribed, emit }),
    } as unknown as PluginHost;
    return { host, emit };
  };

  it('deletes blocked messages even when no plugin subscribes to messages', async () => {
    const fake = buildFakeClient();
    const bridge = new ClientEventBridge(fake.client, silent);
    bridge.attach({ ...baseConfig({}), moderation: moderation() });
    const target = moderatedMessage();
    await fake.fire(Events.MessageCreate, target);
    expect(target.delete).toHaveBeenCalledOnce();
    bridge.detach();
    expect(fake.listeners.get(Events.MessageCreate)).toHaveLength(0);
    expect(fake.listeners.get(Events.MessageUpdate)).toHaveLength(0);
  });

  it.each([false, true])(
    'blocks message plugin fan-out, including when deletion fails (%s)',
    async (deleteFails) => {
      const fake = buildFakeClient();
      const { host, emit } = observedHost([Events.MessageCreate]);
      const bridge = new ClientEventBridge(fake.client, silent);
      bridge.attach({ ...baseConfig({ host }), moderation: moderation() });
      const target = moderatedMessage();
      if (deleteFails) target.delete.mockRejectedValue(new Error('Missing Permissions'));
      await fake.fire(Events.MessageCreate, target);
      expect(target.delete).toHaveBeenCalledOnce();
      expect(emit).not.toHaveBeenCalled();
      expect(fake.listeners.get(Events.MessageCreate)).toHaveLength(1);
    },
  );

  it.each([Events.MessageCreate, Events.MessageUpdate] as const)(
    'deletes attributed external bot responses before %s plugin dispatch',
    async (event) => {
      const fake = buildFakeClient();
      const { host, emit } = observedHost([event]);
      const bridge = new ClientEventBridge(fake.client, silent);
      bridge.attach({ ...baseConfig({ host }), moderation: moderation() });
      const target = {
        ...moderatedMessage(),
        author: { id: 'external-bot', bot: true },
        interactionMetadata: { user: { id: 'blocked-user' } },
      };
      if (event === Events.MessageCreate) await fake.fire(event, target);
      else await fake.fire(event, target, target);
      expect(target.delete).toHaveBeenCalledOnce();
      expect(emit).not.toHaveBeenCalled();
    },
  );

  it('forwards bot responses without a reliable source', async () => {
    const fake = buildFakeClient();
    const { host, emit } = observedHost([Events.MessageCreate]);
    const bridge = new ClientEventBridge(fake.client, silent);
    bridge.attach({ ...baseConfig({ host }), moderation: moderation() });
    const target = { ...moderatedMessage(), author: { id: 'external-bot', bot: true } };
    await fake.fire(Events.MessageCreate, target);
    expect(target.delete).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(Events.MessageCreate, target);
  });

  it('blocks message updates without deleting messages that predate the ban', async () => {
    const fake = buildFakeClient();
    const { host, emit } = observedHost([Events.MessageUpdate]);
    const bridge = new ClientEventBridge(fake.client, silent);
    bridge.attach({ ...baseConfig({ host }), moderation: moderation() });
    const before = moderatedMessage();
    const after = moderatedMessage();
    await fake.fire(Events.MessageUpdate, before, after);
    expect(emit).not.toHaveBeenCalled();
    expect(before.delete).not.toHaveBeenCalled();
    expect(after.delete).not.toHaveBeenCalled();
  });

  it('forwards allowed message creates and updates once', async () => {
    const fake = buildFakeClient();
    const { host, emit } = observedHost([Events.MessageCreate, Events.MessageUpdate]);
    const bridge = new ClientEventBridge(fake.client, silent);
    bridge.attach({ ...baseConfig({ host }), moderation: moderation() });
    const target = { ...moderatedMessage(), author: { id: 'owner', bot: false } };
    await fake.fire(Events.MessageCreate, target);
    await fake.fire(Events.MessageUpdate, target, target);
    expect(emit.mock.calls).toEqual([
      [Events.MessageCreate, target],
      [Events.MessageUpdate, target, target],
    ]);
    expect(target.delete).not.toHaveBeenCalled();
  });

  it('preserves unmoderated message forwarding when disabled', async () => {
    const fake = buildFakeClient();
    const { host, emit } = observedHost([Events.MessageCreate]);
    const bridge = new ClientEventBridge(fake.client, silent);
    bridge.attach(baseConfig({ host }));
    const target = moderatedMessage();
    await fake.fire(Events.MessageCreate, target);
    expect(emit).toHaveBeenCalledWith(Events.MessageCreate, target);
    expect(target.delete).not.toHaveBeenCalled();
  });

  it('rejects blocked interactions before router dispatch', async () => {
    const fake = buildFakeClient();
    const dispatch = vi.fn(async () => {});
    const bridge = new ClientEventBridge(fake.client, silent);
    bridge.attach({ ...baseConfig({ router: fakeRouter(dispatch) }), moderation: moderation() });
    const target = {
      guildId: 'guild',
      channelId: 'thread',
      channel: moderatedMessage().channel,
      user: { id: 'blocked-user' },
      isAutocomplete: () => false,
      isRepliable: () => true,
      reply: vi.fn(async () => {}),
    };
    await fake.fire(Events.InteractionCreate, target);
    expect(target.reply).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
