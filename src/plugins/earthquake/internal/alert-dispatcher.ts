/**
 * Delivers early-warning alerts to every guild's `earthquake` channel and
 * folds the CWA's updated alerts for one quake into the first message.
 *
 * An alert joins the open event when it arrives within
 * {@link EVENT_WINDOW_MS} of that event's latest alert and its epicenter lies
 * within {@link SAME_EVENT_DISTANCE_KM} of the event's latest epicenter;
 * otherwise it starts a new event. A new event posts one message per guild;
 * an update edits those messages, which never pings. The role is pinged from
 * the operator's threshold (`earthquake_alert.ping_min_local_intensity`): when
 * an update is the event's first alert at that threshold, each guild with an
 * `earthquake` role also gets one short reply that pings it.
 *
 * Alerts are processed one at a time, so racing updates cannot post twice.
 * Event state lives in memory only: after a restart the next alert posts a
 * new message.
 */
import { RESTJSONErrorCodes, type Client, type Message } from 'discord.js';

import type { GuildRegistry } from '../../../bot/guild-registry';
import type { Translator } from '../../../core/i18n';
import { logError, type Logger } from '../../../core/logger';
import type { Clock } from '../../../core/time';
import {
  isPingWorthy,
  renderAlertContent,
  renderAlertEmbed,
  renderUpgradeContent,
} from './alert-message';
import type { EarthquakeAlert, Intensity } from './alert-request';

/** Symbolic channel / role name looked up via the guild registry. */
const EARTHQUAKE = 'earthquake';

/** Longest gap between two alerts of one quake. */
export const EVENT_WINDOW_MS = 3 * 60_000;
/** Largest epicenter shift between two alerts of one quake. */
const SAME_EVENT_DISTANCE_KM = 100;

const EARTH_RADIUS_KM = 6371;

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Great-circle (haversine) distance between two points, in kilometres. */
export const distanceKm = (
  a: { readonly lat: number; readonly lon: number },
  b: { readonly lat: number; readonly lon: number },
): number => {
  const dLat = radians(b.lat - a.lat);
  const dLon = radians(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
};

/** One guild's alert message within an event. */
interface GuildAlert {
  readonly message: Pick<Message, 'edit' | 'reply'>;
  /** The role mentioned in the message text, kept on edits so the text stays stable. */
  readonly mentionRoleId: string | undefined;
}

interface AlertEvent {
  lat: number;
  lon: number;
  lastAlertAt: number;
  pinged: boolean;
  readonly guilds: Map<string, GuildAlert>;
}

type DispatchOutcome =
  | {
      readonly kind: 'delivered';
      /** `false` when the alert updated the open event. */
      readonly created: boolean;
      /** Whether any guild's role was pinged for this alert. */
      readonly pinged: boolean;
      /** Guilds whose alert message was posted or edited. */
      readonly guilds: number;
    }
  | { readonly kind: 'not_ready' };

export interface AlertDispatcherDeps {
  readonly client: Client;
  readonly registry: Pick<GuildRegistry, 'getChannel' | 'getRole'>;
  readonly translator: Pick<Translator, 't'>;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Lowest local intensity that pings the guild's `earthquake` role. */
  readonly pingThreshold: Intensity;
}

export interface AlertDispatcher {
  dispatch(alert: EarthquakeAlert): Promise<DispatchOutcome>;
}

const isUnknownMessage = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === RESTJSONErrorCodes.UnknownMessage;

export const createAlertDispatcher = (deps: AlertDispatcherDeps): AlertDispatcher => {
  const { client, registry, translator, logger, pingThreshold } = deps;
  let current: AlertEvent | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const openEventFor = (alert: EarthquakeAlert, now: number): AlertEvent | undefined => {
    if (current === undefined || now - current.lastAlertAt > EVENT_WINDOW_MS) return undefined;
    const shift = distanceKm(current, { lat: alert.epicenterLat, lon: alert.epicenterLon });
    return shift <= SAME_EVENT_DISTANCE_KM ? current : undefined;
  };

  const dispatchUnlocked = async (alert: EarthquakeAlert): Promise<DispatchOutcome> => {
    if (!client.isReady()) return { kind: 'not_ready' };
    const now = deps.clock.now();
    const open = openEventFor(alert, now);
    const event: AlertEvent = open ?? {
      lat: alert.epicenterLat,
      lon: alert.epicenterLon,
      lastAlertAt: now,
      pinged: false,
      guilds: new Map(),
    };
    // The first alert of the event at the threshold pings; later ones only edit.
    const pingNow = isPingWorthy(alert, pingThreshold) && !event.pinged;
    const embed = renderAlertEmbed(alert, translator, {
      pingThreshold,
      updated: open !== undefined,
      timestamp: deps.clock.nowDate(),
    });
    let delivered = 0;
    let pinged = false;

    const deliverTo = async (guildId: string): Promise<void> => {
      const channel = registry.getChannel(guildId, EARTHQUAKE);
      if (channel === undefined || !channel.isSendable()) return;
      const roleId = registry.getRole(guildId, EARTHQUAKE)?.id;
      const existing = event.guilds.get(guildId);
      if (existing !== undefined) {
        try {
          await existing.message.edit({
            content: renderAlertContent(alert, translator, existing.mentionRoleId),
            embeds: [embed],
            allowedMentions: { parse: [] },
          });
          delivered += 1;
          if (pingNow && roleId !== undefined) {
            await existing.message.reply({
              content: renderUpgradeContent(alert, translator, roleId),
              allowedMentions: { roles: [roleId], repliedUser: false },
            });
            pinged = true;
          }
          return;
        } catch (error: unknown) {
          if (!isUnknownMessage(error)) throw error;
          logger.info({ guildId }, 'earthquake alert: message was deleted; posting anew');
        }
      }
      const mentionRoleId = pingNow ? roleId : undefined;
      const message = await channel.send({
        content: renderAlertContent(alert, translator, mentionRoleId),
        embeds: [embed],
        allowedMentions: mentionRoleId === undefined ? { parse: [] } : { roles: [mentionRoleId] },
      });
      event.guilds.set(guildId, { message, mentionRoleId });
      delivered += 1;
      if (mentionRoleId !== undefined) pinged = true;
    };

    await Promise.all(
      [...client.guilds.cache.keys()].map(async (guildId) => {
        try {
          await deliverTo(guildId);
        } catch (error: unknown) {
          logError(logger, guildId, error);
        }
      }),
    );

    if (pingNow) event.pinged = true;
    event.lat = alert.epicenterLat;
    event.lon = alert.epicenterLon;
    event.lastAlertAt = now;
    current = event;
    return { kind: 'delivered', created: open === undefined, pinged, guilds: delivered };
  };

  return {
    dispatch(alert) {
      const run = queue.catch(() => undefined).then(() => dispatchUnlocked(alert));
      queue = run;
      return run;
    },
  };
};
