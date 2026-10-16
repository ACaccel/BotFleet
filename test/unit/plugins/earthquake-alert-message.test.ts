/**
 * Early-warning alert rendering against the real catalogs: intensity labels,
 * coordinates, the embed fields and colour, and the ping headline.
 */
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Locale, Translator } from '../../../src/core/i18n';
import { loadCatalogResources } from '../../../src/core/i18n/catalog-loader';
import { I18NextTranslator } from '../../../src/core/i18n/i18next-translator';
import { EARTHQUAKE_REPORT_COLORS } from '../../../src/infra/discord/presentation-colors';
import {
  formatCoordinates,
  intensityLabel,
  renderAlertContent,
  renderAlertEmbed,
  renderUpgradeContent,
} from '../../../src/plugins/earthquake/internal/alert-message';
import {
  INTENSITIES,
  intensityAtLeast,
  type EarthquakeAlert,
} from '../../../src/plugins/earthquake/internal/alert-request';

const LOCALES_DIR = path.resolve(__dirname, '..', '..', '..', 'src', 'i18n', 'locales');

const translatorFor = (locale: Locale): Promise<Translator> =>
  I18NextTranslator.create(loadCatalogResources({ localesDir: LOCALES_DIR }), locale);

/** The warning app's own test values. */
const ALERT: EarthquakeAlert = {
  epicenterLat: 23.85,
  epicenterLon: 120.82,
  depthKm: 10,
  magnitude: 7.3,
  maxIntensity: '7',
  localIntensity: '5+',
  arrivalTime: 1_717_142_400,
  remainingSeconds: 20,
};

const TIMESTAMP = new Date('2026-10-15T00:00:00Z');

describe('intensity scale', () => {
  it('orders the CWA levels with the split halves between their neighbours', () => {
    expect(intensityAtLeast('4', '4')).toBe(true);
    expect(intensityAtLeast('3', '4')).toBe(false);
    expect(intensityAtLeast('5-', '4')).toBe(true);
    expect(intensityAtLeast('5+', '6-')).toBe(false);
    expect(intensityAtLeast('7', '6+')).toBe(true);
  });

  it('labels every level in both locales', async () => {
    const zh = await translatorFor('zh-TW');
    const en = await translatorFor('en');
    expect(INTENSITIES.map((level) => intensityLabel(level, zh))).toEqual([
      '0級',
      '1級',
      '2級',
      '3級',
      '4級',
      '5弱',
      '5強',
      '6弱',
      '6強',
      '7級',
    ]);
    expect(INTENSITIES.map((level) => intensityLabel(level, en))).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '5 Weak',
      '5 Strong',
      '6 Weak',
      '6 Strong',
      '7',
    ]);
  });
});

describe('formatCoordinates', () => {
  it('uses hemisphere letters instead of signs', () => {
    expect(formatCoordinates(23.85, 120.82)).toBe('23.85°N, 120.82°E');
    expect(formatCoordinates(-33.456, -70.6)).toBe('33.46°S, 70.60°W');
    expect(formatCoordinates(0, 0)).toBe('0.00°N, 0.00°E');
  });
});

describe('renderAlertEmbed', () => {
  it('shows every value of the alert in zh-TW', async () => {
    const zh = await translatorFor('zh-TW');
    const embed = renderAlertEmbed(ALERT, zh, {
      pingThreshold: '4',
      updated: false,
      timestamp: TIMESTAMP,
    });

    expect(embed.title).toBe('強震即時警報');
    expect(embed.color).toBe(EARTHQUAKE_REPORT_COLORS.red);
    expect(embed.fields?.map((field) => field.value)).toEqual([
      'M7.3',
      '10 公里',
      '7級',
      '5強',
      '<t:1717142400:R> (<t:1717142400:T>)',
      '[23.85°N, 120.82°E](https://www.google.com/maps/search/?api=1&query=23.8500,120.8200)',
    ]);
    expect(embed.footer?.text).toContain('地牛Wake Up!');
    expect(embed.footer?.text).not.toContain('已更新');
    expect(embed.timestamp).toBe(TIMESTAMP.toISOString());
  });

  it('turns amber below the ping threshold and marks updates in en', async () => {
    const en = await translatorFor('en');
    const embed = renderAlertEmbed({ ...ALERT, localIntensity: '3', depthKm: 12.34 }, en, {
      pingThreshold: '4',
      updated: true,
      timestamp: TIMESTAMP,
    });

    expect(embed.title).toBe('Earthquake early warning');
    expect(embed.color).toBe(EARTHQUAKE_REPORT_COLORS.orange);
    expect(embed.fields?.[1]?.value).toBe('12.3 km');
    expect(embed.footer?.text).toMatch(/Updated$/);
  });

  it('follows the configured threshold for its colour', async () => {
    const en = await translatorFor('en');
    const colorAt = (localIntensity: EarthquakeAlert['localIntensity']): number | undefined =>
      renderAlertEmbed({ ...ALERT, localIntensity }, en, {
        pingThreshold: '5-',
        updated: false,
        timestamp: TIMESTAMP,
      }).color;

    expect(colorAt('4')).toBe(EARTHQUAKE_REPORT_COLORS.orange);
    expect(colorAt('5-')).toBe(EARTHQUAKE_REPORT_COLORS.red);
    expect(colorAt('7')).toBe(EARTHQUAKE_REPORT_COLORS.red);
  });
});

describe('alert content', () => {
  it('prefixes the headline with the role mention only when pinging', async () => {
    const zh = await translatorFor('zh-TW');

    expect(renderAlertContent(ALERT, zh, undefined)).toBe('**強震即時警報**:本地震度 5強');
    expect(renderAlertContent(ALERT, zh, '42')).toMatch(/^<@&42> \*\*/);
  });

  it('pings the role in the upgrade follow-up', async () => {
    const zh = await translatorFor('zh-TW');

    expect(renderUpgradeContent(ALERT, zh, '42')).toBe('<@&42> 本地震度上修為 5強');
  });
});
