/**
 * Renders an early-warning alert: a headline (with the role mention when the
 * alert pings) and one embed. Edits for a later alert of the same quake reuse
 * the same renderer with the `updated` footer.
 */
import { roleMention, type APIEmbed } from 'discord.js';

import type { Translator } from '../../../core/i18n';
import { EARTHQUAKE_REPORT_COLORS } from '../../../infra/discord/presentation-colors';
import { intensityAtLeast, type EarthquakeAlert, type Intensity } from './alert-request';

/** Translation key suffix per intensity; `-`/`+` are the CWA's lower and upper halves. */
const INTENSITY_KEYS: Readonly<Record<Intensity, string>> = {
  '0': '0',
  '1': '1',
  '2': '2',
  '3': '3',
  '4': '4',
  '5-': '5_lower',
  '5+': '5_upper',
  '6-': '6_lower',
  '6+': '6_upper',
  '7': '7',
};

type T = Pick<Translator, 't'>;

/** The localized label of a CWA intensity, such as `5弱` or `5 Weak`. */
export const intensityLabel = (intensity: Intensity, translator: T): string =>
  translator.t(`replies:earthquake.alert.intensity.${INTENSITY_KEYS[intensity]}`);

/**
 * Whether an alert's local intensity reaches the operator's ping threshold
 * (`earthquake_alert.ping_min_local_intensity`).
 */
export const isPingWorthy = (alert: EarthquakeAlert, threshold: Intensity): boolean =>
  intensityAtLeast(alert.localIntensity, threshold);

/** Two decimals with a hemisphere letter, such as `23.85°N, 120.82°E`. */
export const formatCoordinates = (lat: number, lon: number): string =>
  `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(2)}°${lon < 0 ? 'W' : 'E'}`;

const mapUrl = (lat: number, lon: number): string =>
  `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(4)},${lon.toFixed(4)}`;

/** One decimal at most, so `10` stays `10` and `10.25` reads `10.3`. */
const oneDecimal = (value: number): string => String(Math.round(value * 10) / 10);

/** The message content: the headline, prefixed by the role mention when pinging. */
export const renderAlertContent = (
  alert: EarthquakeAlert,
  translator: T,
  mentionRoleId: string | undefined,
): string => {
  const headline = translator.t('replies:earthquake.alert.headline', {
    intensity: intensityLabel(alert.localIntensity, translator),
  });
  return mentionRoleId === undefined ? headline : `${roleMention(mentionRoleId)} ${headline}`;
};

/** The follow-up that pings the role once an update first reaches the threshold. */
export const renderUpgradeContent = (
  alert: EarthquakeAlert,
  translator: T,
  roleId: string,
): string =>
  `${roleMention(roleId)} ${translator.t('replies:earthquake.alert.upgraded', {
    intensity: intensityLabel(alert.localIntensity, translator),
  })}`;

/**
 * Six inline fields, read as two rows of three on desktop clients. Red at or
 * above the ping threshold, amber below.
 */
export const renderAlertEmbed = (
  alert: EarthquakeAlert,
  translator: T,
  options: {
    readonly pingThreshold: Intensity;
    readonly updated: boolean;
    readonly timestamp: Date;
  },
): APIEmbed => {
  const { epicenterLat: lat, epicenterLon: lon, arrivalTime } = alert;
  return {
    title: translator.t('replies:earthquake.alert.title'),
    color: isPingWorthy(alert, options.pingThreshold)
      ? EARTHQUAKE_REPORT_COLORS.red
      : EARTHQUAKE_REPORT_COLORS.orange,
    fields: [
      {
        name: translator.t('replies:earthquake.alert.magnitude'),
        value: `M${alert.magnitude.toFixed(1)}`,
        inline: true,
      },
      {
        name: translator.t('replies:earthquake.alert.depth'),
        value: translator.t('replies:earthquake.alert.depth_value', {
          depth: oneDecimal(alert.depthKm),
        }),
        inline: true,
      },
      {
        name: translator.t('replies:earthquake.alert.max_intensity'),
        value: intensityLabel(alert.maxIntensity, translator),
        inline: true,
      },
      {
        name: translator.t('replies:earthquake.alert.local_intensity'),
        value: intensityLabel(alert.localIntensity, translator),
        inline: true,
      },
      {
        name: translator.t('replies:earthquake.alert.arrival'),
        value: `<t:${arrivalTime}:R> (<t:${arrivalTime}:T>)`,
        inline: true,
      },
      {
        name: translator.t('replies:earthquake.alert.epicenter'),
        value: `[${formatCoordinates(lat, lon)}](${mapUrl(lat, lon)})`,
        inline: true,
      },
    ],
    footer: {
      text: translator.t(
        options.updated
          ? 'replies:earthquake.alert.footer_updated'
          : 'replies:earthquake.alert.footer',
      ),
    },
    timestamp: options.timestamp.toISOString(),
  };
};
