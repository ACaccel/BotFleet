/**
 * Posts a notification thread's first update to its route's channel and
 * edits that message for every later update.
 *
 * Updates for one thread run one at a time within the process, so two racing
 * first requests cannot both post. The thread's message is remembered in the
 * route guild's database (surviving restarts) and in a small in-process cache
 * (so a failed database write does not duplicate the message on the next
 * update).
 */
import type { Client, GuildTextBasedChannel } from 'discord.js';

import type { Translator } from '../../../core/i18n';
import type { Logger } from '../../../core/logger';
import type { Clock } from '../../../core/time';
import type {
  NotificationThreadId,
  NotificationThreadMessage,
  NotificationThreadRepo,
} from '../../../persistence/repositories/notification-thread.repo';
import type { NotificationRoute } from './config';
import { renderNotification } from './render';
import type { Notification } from './request';

/** Discord error codes for a channel that does not exist or the bot cannot see. */
const MISSING_CHANNEL_CODES = new Set([10003, 50001]);
const UNKNOWN_MESSAGE = 10008;

/** Threads remembered in process; enough for any realistic number of concurrent deployments. */
const RECENT_THREADS_LIMIT = 256;

export type RelayOutcome =
  | { readonly kind: 'delivered'; readonly messageId: string; readonly created: boolean }
  | { readonly kind: 'not_ready' }
  | { readonly kind: 'storage_unavailable' }
  | { readonly kind: 'misconfigured' }
  | { readonly kind: 'discord_failed' };

export interface NotificationRelayDeps {
  readonly client: Client;
  readonly botId: string;
  /** The thread store in a route guild's database; rejects when it cannot be opened. */
  readonly store: (guildId: string) => Promise<NotificationThreadRepo>;
  readonly translator: Pick<Translator, 't'>;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface NotificationRelay {
  deliver(
    routeName: string,
    route: NotificationRoute,
    threadKey: string,
    notification: Notification,
  ): Promise<RelayOutcome>;
}

const errorCode = (error: unknown): unknown =>
  typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;

export const createNotificationRelay = (deps: NotificationRelayDeps): NotificationRelay => {
  const queues = new Map<string, Promise<unknown>>();
  const recent = new Map<string, NotificationThreadMessage>();

  const remember = (cacheKey: string, message: NotificationThreadMessage): void => {
    recent.delete(cacheKey);
    recent.set(cacheKey, message);
    if (recent.size > RECENT_THREADS_LIMIT) {
      const oldest = recent.keys().next().value;
      if (oldest !== undefined) recent.delete(oldest);
    }
  };

  const resolveChannel = async (
    routeName: string,
    route: NotificationRoute,
  ): Promise<GuildTextBasedChannel | 'misconfigured' | 'discord_failed'> => {
    const context = { route: routeName, guildId: route.guildId, channelId: route.channelId };
    let channel;
    try {
      channel = await deps.client.channels.fetch(route.channelId);
    } catch (error: unknown) {
      if (MISSING_CHANNEL_CODES.has(errorCode(error) as number)) {
        deps.logger.error(context, 'notification relay: route channel is missing or not visible');
        return 'misconfigured';
      }
      deps.logger.error(
        { ...context, code: errorCode(error) },
        'notification relay: channel fetch failed',
      );
      return 'discord_failed';
    }
    if (
      channel === null ||
      !channel.isTextBased() ||
      channel.isDMBased() ||
      channel.guildId !== route.guildId
    ) {
      deps.logger.error(
        context,
        'notification relay: route channel is not a text channel of its guild',
      );
      return 'misconfigured';
    }
    return channel;
  };

  const deliverUnlocked = async (
    routeName: string,
    route: NotificationRoute,
    threadKey: string,
    notification: Notification,
    cacheKey: string,
  ): Promise<RelayOutcome> => {
    if (!deps.client.isReady()) return { kind: 'not_ready' };
    const channel = await resolveChannel(routeName, route);
    if (typeof channel === 'string') return { kind: channel };

    const id: NotificationThreadId = { botId: deps.botId, route: routeName, threadKey };
    const context = { route: routeName, threadKey };
    let store: NotificationThreadRepo;
    try {
      store = await deps.store(route.guildId);
    } catch (error: unknown) {
      deps.logger.error({ ...context, err: error }, 'notification relay: thread store unavailable');
      return { kind: 'storage_unavailable' };
    }
    let existing = recent.get(cacheKey);
    if (existing === undefined) {
      const found = await store.find(id);
      if (!found.ok) {
        deps.logger.error(
          { ...context, err: found.error },
          'notification relay: thread lookup failed',
        );
        return { kind: 'storage_unavailable' };
      }
      existing = found.value;
    }

    const now = deps.clock.nowDate();
    const payload = {
      embeds: [renderNotification(notification, deps.translator, now)],
      allowedMentions: { parse: [] },
    };
    const save = async (message: NotificationThreadMessage): Promise<void> => {
      remember(cacheKey, message);
      const saved = await store.save(id, message, now);
      if (!saved.ok) {
        deps.logger.warn(
          { ...context, err: saved.error },
          'notification relay: thread save failed',
        );
      }
    };

    // A route moved to another channel starts a new message there.
    if (existing !== undefined && existing.channelId === channel.id) {
      try {
        await channel.messages.edit(existing.messageId, payload);
        await save(existing);
        return { kind: 'delivered', messageId: existing.messageId, created: false };
      } catch (error: unknown) {
        if (errorCode(error) !== UNKNOWN_MESSAGE) {
          deps.logger.error(
            { ...context, code: errorCode(error) },
            'notification relay: edit failed',
          );
          return { kind: 'discord_failed' };
        }
        deps.logger.info(context, 'notification relay: thread message was deleted; posting anew');
      }
    }

    let sent;
    try {
      sent = await channel.send(payload);
    } catch (error: unknown) {
      deps.logger.error({ ...context, code: errorCode(error) }, 'notification relay: send failed');
      return { kind: 'discord_failed' };
    }
    await save({ channelId: channel.id, messageId: sent.id });
    return { kind: 'delivered', messageId: sent.id, created: true };
  };

  return {
    async deliver(routeName, route, threadKey, notification) {
      const cacheKey = JSON.stringify([routeName, threadKey]);
      const previous = queues.get(cacheKey) ?? Promise.resolve();
      const current = previous
        .catch(() => undefined)
        .then(() => deliverUnlocked(routeName, route, threadKey, notification, cacheKey));
      queues.set(cacheKey, current);
      try {
        return await current;
      } finally {
        if (queues.get(cacheKey) === current) queues.delete(cacheKey);
      }
    },
  };
};
