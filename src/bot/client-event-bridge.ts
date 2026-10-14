/**
 * Adapter between Discord's raw `client.on(...)` event stream and the
 * bot's internal dispatch surfaces (the InteractionRouter and the plugin
 * EventDispatcher).
 *
 * Pattern: Adapter — the bridge owns one direction only (Discord →
 * domain). Every per-event branch is a thin translation that hands off
 * to a typed seam; the bridge holds no domain state.
 *
 * Single attach point with a matching `detach` so tests can build a
 * bridge per spec without leaking listeners. Re-attach without detach
 * is a contract violation and throws `ConfigurationError`.
 */
import { randomUUID } from 'node:crypto';

import { MessageFlags } from 'discord.js';
import type { Client, ClientEvents, Guild, Interaction } from 'discord.js';
import { Events } from 'discord.js';

import type { Translator } from '../core/i18n';
import { type ServiceContainer, type ServiceToken } from '../core/ioc';
import { logError, logGuildEvent, logSystem, ops, type Logger } from '../core/logger';
// Audit-log coverage:
//   - `interaction_create` lines emit from `createChannelLoggingMiddleware`.
//   - `message_update` / `message_delete` / `guild_member_update` /
//     `guild_create` lines emit from `GuildEventsPlugin`. A bulk purge
//     emits a `message_delete` line tagged `source: 'bulk'` for each
//     message whose cached attachments were rescued — Discord sends no
//     per-message delete for those, so it is the only record of them.
import type {
  GuildOnboardingPort,
  InteractionContext,
  InteractionRouter,
  PluginHost,
} from '../core/plugin';
import type { Clock } from '../core/time';

import type { GuildInfo } from './index';
import { TOKENS } from './tokens';
import type { ThreadModeration } from './thread-moderation';

/**
 * Per-bot suppression flags. A subclass that does not want one of the
 * bridge's raw listeners installed flips the corresponding bit (for
 * example: `msg-archive` opts out of every interactive event).
 */
export interface ClientEventBridgeSuppression {
  /** When true the InteractionCreate listener is not installed. */
  readonly interaction?: boolean;
  /** When true the fallback GuildCreate listener is not installed. */
  readonly guildCreate?: boolean;
}

/**
 * Static configuration passed to {@link ClientEventBridge.attach}. The
 * bridge resolves every other dependency it needs through `container`.
 */
interface ClientEventBridgeConfig {
  readonly moderation?: ThreadModeration;
  readonly container: ServiceContainer;
  readonly host: PluginHost;
  readonly router: InteractionRouter | undefined;
  /** Live view over the bot's `guildInfo` — read only. */
  readonly guildInfo: () => ReadonlyMap<string, GuildInfo>;
  readonly suppression?: ClientEventBridgeSuppression;
}

/** Captured (event, listener) pair so {@link detach} can `off()` cleanly. */
interface Subscription {
  readonly event: keyof ClientEvents;
  readonly listener: (...args: unknown[]) => unknown;
}

export class ClientEventBridge {
  private readonly client: Client;
  private readonly logger: Logger;
  private config: ClientEventBridgeConfig | undefined;
  private readonly subscriptions: Subscription[] = [];

  public constructor(client: Client, logger: Logger) {
    this.client = client;
    this.logger = logger;
  }

  /**
   * Install every raw Discord listener and forward every plugin
   * EventDispatcher subscription onto `client.on`. Must be called
   * exactly once between attach / detach cycles — a duplicate attach
   * surfaces as `ConfigurationError` with a stable code so callers
   * can distinguish a contract violation from a transient bug.
   *
   * Must be invoked AFTER `host.startAll()` resolves; the dispatcher
   * subscription list is only stable from that point.
   */
  public attach(config: ClientEventBridgeConfig): void {
    if (this.config !== undefined) {
      // Contract violation, not a domain failure — see
      // project-conventions §5: invariant breaches use native
      // TypeError. The stable code lives in the message so
      // callers / test fixtures can grep for it.
      throw new TypeError(
        'ClientEventBridge.attach: EVENT_BRIDGE_ALREADY_ATTACHED — call detach() before re-attaching.',
      );
    }
    this.config = config;
    this.installRawListeners(config);
    this.installDispatcherForwarders(config.host);
  }

  /**
   * Remove every listener installed by {@link attach}. Safe to call
   * more than once and safe to call before any attach — tests / the
   * shutdown path may invoke it speculatively.
   */
  public detach(): void {
    for (const sub of this.subscriptions) {
      // discord.js's typed `off` requires the event-key narrowed
      // tuple; the captured listener carries the matching shape.
      this.client.off(sub.event, sub.listener as never);
    }
    this.subscriptions.length = 0;
    this.config = undefined;
  }

  /**
   * For each guild whose `debug` channel is sendable, send the
   * localised reboot notice. Best-effort: per-guild failures only log
   * — one broken debug channel must not delay `pluginHost.readyAll`.
   */
  public async sendRebootMessages(translator: Translator | undefined): Promise<void> {
    const guildInfo = this.config?.guildInfo() ?? new Map<string, GuildInfo>();
    await Promise.all(
      Array.from(guildInfo.values()).map(async (slot) => {
        try {
          const debugChannel = slot.channels?.debug;
          if (debugChannel === undefined || !debugChannel.isSendable()) return;
          const message =
            translator?.t('replies:base_bot.reboot_notice', {
              botName: slot.bot_name,
            }) ?? '';
          if (message.length === 0) return;
          await debugChannel.send(message);
        } catch (err) {
          logError(this.logger, slot.guild.id, err);
        }
      }),
    );
  }

  /** Install the raw `client.on(...)` branches the bridge owns. */
  private installRawListeners(config: ClientEventBridgeConfig): void {
    const suppress = config.suppression ?? {};

    if (suppress.interaction !== true) {
      this.on(Events.InteractionCreate, async (interaction: Interaction) => {
        await this.onInteraction(interaction).catch((err) => {
          logError(this.logger, interaction.guildId ?? null, err);
        });
      });
    }

    // BaseBot historically wired no-op default listeners for the
    // message events so subclasses could override; that wiring is
    // gone — plugins subscribe through the EventDispatcher when
    // they care. Skipping the no-ops here keeps client.on listener
    // counts at their minimum.

    // GuildMemberUpdate has no BaseBot-owned behaviour; plugins
    // subscribe through the dispatcher. The dispatcher forwarder
    // (below) handles it for any plugin that subscribes.

    // Fallback GuildCreate listener — only when no plugin owns the
    // event and the bot has not opted out (msg-archive / konata
    // pass suppression.guildCreate = true).
    if (suppress.guildCreate !== true && !this.dispatcherSubscribesTo(Events.GuildCreate)) {
      this.on(Events.GuildCreate, async (guild: Guild) => {
        await this.onGuildCreate(guild).catch((err) => {
          logError(this.logger, guild.id ?? null, err);
        });
      });
    }
  }

  /**
   * Install one `client.on(event, dispatcher.emit)` per plugin
   * subscription. The dispatcher already does per-subscription error
   * isolation; wrapping its `emit` in `void` keeps the discord.js
   * listener signature `(...args) => void` happy.
   */
  private installDispatcherForwarders(host: PluginHost): void {
    const dispatcher = host.getEventDispatcher();
    const moderation = this.config?.moderation;
    const events = dispatcher.subscribedEvents();
    if (moderation) {
      // Moderation must also run on bots with no message-producing plugins.
      this.on(Events.MessageCreate, async (message) => {
        try {
          if (await moderation.allowMessage(message, true)) {
            await dispatcher.emit(Events.MessageCreate, message);
          }
        } catch (err) {
          logError(this.logger, message.guildId, err);
        }
      });
      this.on(Events.MessageUpdate, async (before, after) => {
        try {
          if (await moderation.allowMessage(after, false)) {
            await dispatcher.emit(Events.MessageUpdate, before, after);
          }
        } catch (err) {
          logError(this.logger, after.guildId, err);
        }
      });
    }
    for (const event of events) {
      if (moderation && (event === Events.MessageCreate || event === Events.MessageUpdate))
        continue;
      this.on(event, (...args: ClientEvents[typeof event]) => {
        void dispatcher.emit(event, ...args);
      });
    }
  }

  /** True when a plugin already subscribes to `event`. */
  private dispatcherSubscribesTo(event: keyof ClientEvents): boolean {
    const host = this.config?.host;
    if (host === undefined) return false;
    return host.getEventDispatcher().subscribedEvents().includes(event);
  }

  /**
   * Capture a (event, listener) pair, install it via `client.on`, and
   * remember it so {@link detach} can mirror the removal.
   */
  private on<K extends keyof ClientEvents>(
    event: K,
    listener: (...args: ClientEvents[K]) => void | Promise<void>,
  ): void {
    this.client.on(event, listener);
    this.subscriptions.push({
      event,
      listener: listener as unknown as (...args: unknown[]) => unknown,
    });
  }

  private async onInteraction(interaction: Interaction): Promise<void> {
    const config = this.config;
    if (config === undefined) return;
    if (config.moderation && !(await config.moderation.allowInteraction(interaction))) return;
    // Pre-router defensive path: BaseBot calls `attach` only after
    // the router is built; the branch here keeps the bridge
    // robust under unit-test setups that drive it directly.
    const router = config.router;
    if (router === undefined) {
      if (!interaction.isAutocomplete() && interaction.isRepliable()) {
        const translator = config.container.tryResolve<Translator>(TOKENS.Translator);
        await interaction.reply({
          content: translator?.t('errors:command.handler_not_initialised') ?? '',
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }
    const translator = config.container.tryResolve<Translator>(TOKENS.Translator);
    if (translator === undefined) {
      // Defensive: translator is registered before the router is
      // built — either both are present or both absent. Unreachable
      // in production, but the branch keeps strict typing honest.
      return;
    }
    const rootLogger = config.container.resolve<Logger>(TOKENS.Logger);
    const clock = config.container.resolve<Clock>(TOKENS.Clock);
    // First 8 chars of a v4 UUID — pure random, no
    // birthday-paradox collisions like `Math.random().toString(36)`.
    const traceId = randomUUID().slice(0, 8);
    const ctx: InteractionContext = {
      interaction,
      traceId,
      logger: rootLogger.child({ traceId }),
      translator,
      clock,
      resolve: <T>(token: ServiceToken<T>): T => config.container.resolve<T>(token),
      state: new Map<string, unknown>(),
    };
    try {
      await router.dispatch(ctx);
    } catch (err) {
      // A dispatch-chain throw must still produce a user-visible
      // reply. Surface the traceId so support tickets correlate
      // to the structured log line.
      logError(this.logger, interaction.guildId, err);
      if (interaction.isRepliable()) {
        const content =
          translator.t('errors:unexpected', { traceId }) ?? `Internal error (traceId=${traceId}).`;
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
          } else {
            await interaction.reply({ content, flags: MessageFlags.Ephemeral });
          }
        } catch (replyErr) {
          logSystem(this.logger, ops.router.replySkipped(String(replyErr)));
        }
      }
    }
  }

  private async onGuildCreate(guild: Guild): Promise<void> {
    const container = this.config?.container;
    if (container === undefined) return;
    const port = container.resolve<GuildOnboardingPort>(TOKENS.GuildOnboardingPort);
    await port.onboardGuild(guild.id);
    // Bridge owns this fallback path only when no plugin subscribes
    // to GuildCreate; emit the audit-log line so the file sink files
    // it under the per-guild directory. Logged after onboarding so
    // a failed connect surfaces as a separate `logError` upstream.
    logGuildEvent(
      this.logger,
      guild.id,
      'guild_create',
      {
        guildId: guild.id,
        ownerId: guild.ownerId,
        memberCount: guild.memberCount,
      },
      guild.name,
    );
  }
}
