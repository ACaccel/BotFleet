/**
 * Smoke coverage for the `/traffic` canvas renderers plus a unit test of
 * the `niceTicks` axis-scale helper. Each renderer returns a named PNG
 * attachment with a non-empty buffer and tolerates empty input.
 */
import { AttachmentBuilder } from 'discord.js';
import { describe, expect, it } from 'vitest';

import {
  renderRankingBarChart,
  renderTimeSeriesChart,
  renderTrafficCharts,
} from '../../../../src/handlers/commands/traffic-shared/chart';
import {
  niceTicks,
  stripEmoji,
} from '../../../../src/handlers/commands/traffic-shared/chart-common';

describe('stripEmoji', () => {
  it('drops emoji / pictographs the chart font cannot render', () => {
    expect(stripEmoji('🐭鼠鼠幫')).toBe('鼠鼠幫');
    expect(stripEmoji('紅溫荷蘭魚→🐟🐠↩:無衣可')).toBe('紅溫荷蘭魚→↩:無衣可');
    expect(stripEmoji('plain-channel')).toBe('plain-channel');
  });

  it('keeps the original when stripping would leave nothing', () => {
    expect(stripEmoji('🐭🐟')).toBe('🐭🐟');
  });
});

describe('niceTicks', () => {
  it('returns a 0..1 axis for a non-positive max', () => {
    expect(niceTicks(0)).toEqual({ niceMax: 1, ticks: [0, 1] });
    expect(niceTicks(-5)).toEqual({ niceMax: 1, ticks: [0, 1] });
  });

  it('produces integer ticks from 0 up to a niceMax >= the data max', () => {
    for (const max of [3, 7, 512, 1234]) {
      const { niceMax, ticks } = niceTicks(max);
      expect(niceMax).toBeGreaterThanOrEqual(max);
      expect(ticks[0]).toBe(0);
      expect(ticks[ticks.length - 1]).toBe(niceMax);
      expect(ticks.every((t) => Number.isInteger(t))).toBe(true);
    }
  });
});

describe('traffic chart renderers', () => {
  it('renders a time-series line chart PNG with the given name', () => {
    const att = renderTimeSeriesChart(
      'Messages over time',
      'Messages',
      [
        { label: '01', value: 3 },
        { label: '02', value: 5 },
      ],
      'traffic-time.png',
    );
    expect(att).toBeInstanceOf(AttachmentBuilder);
    expect(att.name).toBe('traffic-time.png');
    expect((att.attachment as Buffer).length).toBeGreaterThan(0);
  });

  it('draws distinct Chinese glyphs in chart titles and labels', () => {
    const chart = (title: string): Buffer =>
      renderTimeSeriesChart(title, 'Messages', [{ label: '01', value: 1 }], 'time.png')
        .attachment as Buffer;
    const ranking = (label: string): Buffer =>
      renderRankingBarChart('Channels', [{ label, value: 1 }], 1, 'channels.png')
        .attachment as Buffer;
    expect(chart('繁體').equals(chart('測試'))).toBe(false);
    expect(ranking('繁體').equals(ranking('測試'))).toBe(false);
  });

  it('tolerates empty ranking rows without throwing', () => {
    expect(() =>
      renderRankingBarChart('Top channels', [], 0, 'traffic-channels.png'),
    ).not.toThrow();
  });

  it('renders all three charts in display order', () => {
    const files = renderTrafficCharts({
      total: 2,
      timeTitle: 'time',
      timeYAxisLabel: 'Messages',
      timePoints: [{ label: 'a', value: 1 }],
      channelsTitle: 'channels',
      channelRows: [{ label: 'general', value: 1 }],
      usersTitle: 'users',
      userRows: [],
    });
    expect(files.map((f) => f.name)).toEqual([
      'traffic-time.png',
      'traffic-channels.png',
      'traffic-users.png',
    ]);
  });
});
