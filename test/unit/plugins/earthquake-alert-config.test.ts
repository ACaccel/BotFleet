/** The `earthquake_alert` block: defaults when absent, strict otherwise. */
import { describe, expect, it } from 'vitest';

import nijikaExample from '../../../src/bot/nijika/config.example.json';
import { parseEarthquakeAlertConfig } from '../../../src/plugins/earthquake/internal/alert-config';

describe('earthquake_alert config', () => {
  it('defaults the ping threshold to local intensity 4 when the block or field is absent', () => {
    expect(parseEarthquakeAlertConfig(undefined)).toEqual({ pingMinLocalIntensity: '4' });
    expect(parseEarthquakeAlertConfig({})).toEqual({ pingMinLocalIntensity: '4' });
  });

  it('accepts any CWA intensity, including the split halves', () => {
    expect(parseEarthquakeAlertConfig({ ping_min_local_intensity: '5-' })).toEqual({
      pingMinLocalIntensity: '5-',
    });
    expect(parseEarthquakeAlertConfig({ ping_min_local_intensity: '0' })).toEqual({
      pingMinLocalIntensity: '0',
    });
  });

  it('parses the shipped example', () => {
    expect(parseEarthquakeAlertConfig(nijikaExample.earthquake_alert)).toEqual({
      pingMinLocalIntensity: '4',
    });
  });

  it.each([
    ['an unknown level', { ping_min_local_intensity: '8' }, /ping_min_local_intensity/],
    ['a level without its half', { ping_min_local_intensity: '5' }, /ping_min_local_intensity/],
    ['a number', { ping_min_local_intensity: 4 }, /ping_min_local_intensity/],
    ['an unknown key', { ping_min_local_intensity: '4', role: 'x' }, /Unrecognized key/],
    ['a non-object block', '4', /earthquake_alert/],
  ])('rejects %s with a message naming the field', (_label, raw, message) => {
    expect(() => parseEarthquakeAlertConfig(raw)).toThrow(/^Invalid earthquake_alert config/);
    expect(() => parseEarthquakeAlertConfig(raw)).toThrow(message);
  });
});
