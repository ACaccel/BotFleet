/**
 * Unit tests for the CWA significant-earthquake-report path: payload
 * parsing against a trimmed real response, the HTTP request shape, the
 * embed, the per-guild fan-out, and the poller's cursor, ordering and
 * error tolerance. The plugin's lifecycle wiring is covered in
 * `earthquake-plugin.test.ts`.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Channel, Client, EmbedBuilder } from 'discord.js';

import fixture from '../../fixtures/earthquake/cwa-e-a0015-001.json';
import type { GuildRegistry } from '../../../src/bot/guild-registry';
import { createDefaultTranslator, type Translator } from '../../../src/core/i18n';
import type { Logger } from '../../../src/core/logger';
import { boundedHttp } from '../../../src/infra/http';
import {
  EARTHQUAKE_REPORT_COLORS,
  EMBED_COLORS,
} from '../../../src/infra/discord/presentation-colors';
import {
  broadcastEarthquakeReport,
  createReportPoller,
  fetchSignificantReports,
  startReportPolling,
  type ParsedReports,
} from '../../../src/plugins/earthquake/internal';
import {
  parseReportPayload,
  type CwaReport,
} from '../../../src/plugins/earthquake/internal/cwa-report';
import {
  buildReportEmbed,
  intensityRank,
  summariseCountyIntensities,
} from '../../../src/plugins/earthquake/internal/report-embed';

let translator: Translator;

beforeAll(async () => {
  translator = await createDefaultTranslator({
    localesDir: 'src/i18n/locales',
    fallbackLocale: 'en',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const makeLogger = (): {
  logger: Logger;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} => {
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const logger = {
    info,
    warn,
    error,
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => logger,
  } as unknown as Logger;
  return { logger, info, warn, error };
};

/** A deep copy of the fixture's raw entries, safe to mutate per test. */
const rawEntries = (): Record<string, unknown>[] =>
  structuredClone(fixture.records.Earthquake) as unknown as Record<string, unknown>[];

const payloadWith = (entries: unknown[]): unknown => ({
  ...fixture,
  records: { ...fixture.records, Earthquake: entries },
});

const report = (number: number, overrides: Partial<CwaReport> = {}): CwaReport => ({
  number,
  color: undefined,
  content: `report ${number}`,
  imageUrl: undefined,
  webUrl: undefined,
  originTimeMs: Date.parse('2026-09-22T05:16:13+08:00'),
  magnitude: 4.2,
  depthKm: 7.5,
  epicenter: 'somewhere',
  areas: [],
  ...overrides,
});

const batch = (...numbers: number[]): ParsedReports => ({
  reports: numbers.map((n) => report(n)),
  rejected: [],
});

describe('parseReportPayload', () => {
  it('parses every report in a real response', () => {
    const { reports, rejected } = parseReportPayload(fixture);

    expect(rejected).toEqual([]);
    expect(reports.map((r) => r.number)).toEqual([115064, 115063]);
    const [newest] = reports;
    expect(newest).toMatchObject({
      number: 115064,
      magnitude: 4.2,
      depthKm: 7.5,
      originTimeMs: Date.parse('2026-09-21T21:16:13Z'),
      webUrl: 'https://scweb.cwa.gov.tw/zh-tw/earthquake/details/2026064',
      imageUrl: expect.stringMatching(/^https:\/\/scweb\.cwa\.gov\.tw\/.+\.png$/),
    });
    expect(newest?.areas.length).toBeGreaterThan(0);
  });

  it('skips a malformed report and keeps the rest', () => {
    const entries = rawEntries();
    delete (entries[0] as { EarthquakeInfo?: unknown }).EarthquakeInfo;

    const { reports, rejected } = parseReportPayload(payloadWith(entries));

    expect(reports.map((r) => r.number)).toEqual([115063]);
    expect(rejected).toEqual([
      expect.objectContaining({ index: 0, number: 115064, paths: ['EarthquakeInfo'] }),
    ]);
  });

  it('ignores unknown fields and drops an unusable link instead of the report', () => {
    const entries = rawEntries();
    Object.assign(entries[0] as object, { Web: 'javascript:alert(1)', SomethingNew: { a: 1 } });

    const [parsed] = parseReportPayload(payloadWith(entries)).reports;

    expect(parsed?.number).toBe(115064);
    expect(parsed?.webUrl).toBeUndefined();
  });

  it('reads a bare timestamp as Taiwan time, not host-local time', () => {
    const entries = rawEntries();
    const info = (entries[0] as { EarthquakeInfo: { OriginTime: string } }).EarthquakeInfo;
    info.OriginTime = '2026-09-22 05:16:13';

    const [parsed] = parseReportPayload(payloadWith(entries)).reports;

    expect(parsed?.originTimeMs).toBe(Date.parse('2026-09-22T05:16:13+08:00'));
  });

  it('throws when the envelope carries no report list', () => {
    expect(() => parseReportPayload({ success: 'true', result: {} })).toThrow();
    expect(() => parseReportPayload('Authorization key is not correct.')).toThrow();
  });
});

describe('fetchSignificantReports', () => {
  it('requests the newest reports with the key as a query parameter', async () => {
    const get = vi.spyOn(boundedHttp, 'get').mockResolvedValue({ data: fixture } as never);

    const { reports } = await fetchSignificantReports('cwa-test-key');

    expect(reports).toHaveLength(2);
    const [url, config] = get.mock.calls[0] ?? [];
    expect(url).toBe('https://opendata.cwa.gov.tw/api/v1/rest/datastore/E-A0015-001');
    const params = config?.params as { Authorization?: string; limit?: number } | undefined;
    expect(params?.Authorization).toBe('cwa-test-key');
    expect(params?.limit).toBeGreaterThan(0);
  });

  it('propagates an HTTP failure such as a rejected key', async () => {
    vi.spyOn(boundedHttp, 'get').mockRejectedValue(
      Object.assign(new Error('Request failed with status code 401'), {
        response: { status: 401 },
      }),
    );

    await expect(fetchSignificantReports('bad-key')).rejects.toThrow(/401/);
  });
});

describe('intensity summary', () => {
  it('ranks the split levels between their neighbours', () => {
    const labels = ['4級', '5弱', '5強', '6弱', '6強', '7級'];
    const ranks = labels.map(intensityRank);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(new Set(ranks).size).toBe(labels.length);
    expect(intensityRank('unknown')).toBeLessThan(intensityRank('0級'));
  });

  it('keeps each county once at its strongest level, strongest first', () => {
    const [parsed] = parseReportPayload(fixture).reports;

    const summary = summariseCountyIntensities(parsed?.areas ?? []);

    // Summary rows join several counties; every one of them is listed.
    expect(summary.map((s) => s.county)).toEqual([
      '臺南市',
      '嘉義縣',
      '高雄市',
      '嘉義市',
      '雲林縣',
      '臺東縣',
      '南投縣',
      '花蓮縣',
      '彰化縣',
    ]);
    expect(summary[0]).toEqual({ county: '臺南市', intensity: '4級' });
    expect(new Set(summary.map((s) => s.county)).size).toBe(summary.length);
  });

  it('upgrades a county seen at a weaker level elsewhere in the report', () => {
    const summary = summariseCountyIntensities([
      { county: 'A、B', intensity: '3級' },
      { county: 'B', intensity: '5強' },
      { county: 'C', intensity: '5弱' },
    ]);

    expect(summary).toEqual([
      { county: 'B', intensity: '5強' },
      { county: 'C', intensity: '5弱' },
      { county: 'A', intensity: '3級' },
    ]);
  });
});

describe('buildReportEmbed', () => {
  const fieldValue = (embed: EmbedBuilder, name: string): string | undefined =>
    embed.data.fields?.find((f) => f.name === name)?.value;

  it('renders the report with translated labels and upstream data', () => {
    const [parsed] = parseReportPayload(fixture).reports;
    const embed = buildReportEmbed(parsed as CwaReport, translator);
    const { data } = embed;

    expect(data.title).toBe('Earthquake report No. 115064');
    expect(data.description).toBe(parsed?.content);
    expect(data.url).toBe(parsed?.webUrl);
    expect(data.image?.url).toBe(parsed?.imageUrl);
    expect(data.color).toBe(EARTHQUAKE_REPORT_COLORS.green);
    expect(data.footer?.text).toMatch(/Central Weather Administration/);
    expect(fieldValue(embed, 'Origin time')).toBe(
      `<t:${Math.floor(Date.parse('2026-09-22T05:16:13+08:00') / 1000)}:F>`,
    );
    expect(fieldValue(embed, 'Magnitude (ML)')).toBe('4.2');
    expect(fieldValue(embed, 'Depth')).toBe('7.5 km');
    // Runs of padding spaces in the upstream location are collapsed.
    expect(fieldValue(embed, 'Epicenter')).not.toMatch(/ {2}/);
    expect(fieldValue(embed, 'Maximum intensity by county')?.split('\n')[0]).toBe('臺南市 4級');
  });

  it('falls back to the info colour and omits optional parts', () => {
    const embed = buildReportEmbed(report(1, { color: 'purple' }), translator);

    expect(embed.data.color).toBe(EMBED_COLORS.info);
    expect(embed.data.url).toBeUndefined();
    expect(embed.data.image).toBeUndefined();
    expect(fieldValue(embed, 'Maximum intensity by county')).toBeUndefined();
  });

  it('caps a long intensity list within the field limit and counts the rest', () => {
    const areas = Array.from({ length: 200 }, (_, i) => ({
      county: `County number ${i}`,
      intensity: '1級',
    }));
    const embed = buildReportEmbed(report(1, { areas }), translator);
    const value = fieldValue(embed, 'Maximum intensity by county') ?? '';

    expect(value.length).toBeLessThanOrEqual(1024);
    const lines = value.split('\n');
    const listed = lines.length - 1;
    expect(lines.at(-1)).toBe(`...and ${200 - listed} more`);
  });

  it('keeps an oversized report within the embed total', () => {
    const embed = buildReportEmbed(
      report(1, { content: 'x'.repeat(10_000), epicenter: 'y'.repeat(5_000) }),
      translator,
    );

    const { data } = embed;
    // Discord counts title, description, field names and values, and footer.
    const total =
      (data.title?.length ?? 0) +
      (data.description?.length ?? 0) +
      (data.footer?.text.length ?? 0) +
      (data.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0);
    expect(data.description?.length).toBeLessThanOrEqual(4096);
    expect(data.fields?.every((f) => f.value.length <= 1024)).toBe(true);
    expect(total).toBeLessThanOrEqual(6000);
  });
});

describe('broadcastEarthquakeReport', () => {
  const buildClient = (guildIds: readonly string[]): Client =>
    ({ guilds: { cache: new Map(guildIds.map((id) => [id, { id }])) } }) as unknown as Client;

  it('posts to every guild with an earthquake channel, role or not, without pinging', async () => {
    const send = vi.fn(async () => undefined);
    const registry = {
      getChannel: (guildId: string) =>
        guildId === 'none' ? undefined : ({ isSendable: () => true, send } as unknown as Channel),
      getRole: () => undefined,
    } as unknown as GuildRegistry;
    const { logger } = makeLogger();

    await broadcastEarthquakeReport(
      buildClient(['a', 'b', 'none']),
      registry,
      report(7),
      translator,
      logger,
    );

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ allowedMentions: { parse: [] }, embeds: [expect.anything()] }),
    );
  });

  it('isolates a per-guild failure', async () => {
    const sendOk = vi.fn(async () => undefined);
    const registry = {
      getChannel: (guildId: string) =>
        ({
          isSendable: () => true,
          send:
            guildId === 'bad'
              ? async () => {
                  throw new Error('Missing Permissions');
                }
              : sendOk,
        }) as unknown as Channel,
    } as unknown as GuildRegistry;
    const { logger, error } = makeLogger();

    await expect(
      broadcastEarthquakeReport(
        buildClient(['bad', 'good']),
        registry,
        report(7),
        translator,
        logger,
      ),
    ).resolves.toBeUndefined();
    expect(sendOk).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });
});

describe('createReportPoller', () => {
  const setup = (...answers: (ParsedReports | Error)[]) => {
    const fetchReports = vi.fn(async () => {
      const next = answers.shift();
      if (next === undefined) throw new Error('no scripted answer');
      if (next instanceof Error) throw next;
      return next;
    });
    const publish = vi.fn(async (_report: CwaReport) => undefined);
    const log = makeLogger();
    const poller = createReportPoller({ fetchReports, publish, logger: log.logger });
    const published = (): number[] => publish.mock.calls.map(([r]) => r.number);
    return { poller, publish, published, ...log };
  };

  it('seeds from the newest report on the first poll without posting', async () => {
    const { poller, published } = setup(batch(115063, 115064), batch(115063, 115064));

    await poller.poll();
    await poller.poll();

    expect(published()).toEqual([]);
  });

  it('posts only newer reports, oldest first, once each', async () => {
    const { poller, published } = setup(
      batch(115062, 115063),
      batch(115065, 115064, 115063),
      batch(115065, 115064),
    );

    await poller.poll();
    await poller.poll();
    await poller.poll();

    expect(published()).toEqual([115064, 115065]);
  });

  it('seeds from a parsed report on the CWA fixture', async () => {
    const parsed = parseReportPayload(fixture);
    const older: ParsedReports = { reports: parsed.reports.slice(1), rejected: [] };
    const { poller, published } = setup(older, parsed);

    await poller.poll();
    await poller.poll();

    expect(published()).toEqual([115064]);
  });

  it('does not seed from an empty answer', async () => {
    const { poller, published } = setup(batch(), batch(10), batch(10, 11));

    await poller.poll();
    await poller.poll();
    await poller.poll();

    expect(published()).toEqual([11]);
  });

  it('retries after a failure and logs a repeated failure once', async () => {
    const unauthorised = (): Error =>
      Object.assign(new Error('Request failed with status code 401'), {
        response: { status: 401 },
      });
    const { poller, published, warn, info } = setup(
      unauthorised(),
      unauthorised(),
      unauthorised(),
      batch(5),
      batch(5, 6),
    );

    for (let i = 0; i < 5; i += 1) await poller.poll();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ failure: 'HTTP 401' });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ failure: 'HTTP 401' }),
      expect.stringMatching(/recovered/),
    );
    expect(published()).toEqual([6]);
  });

  it('logs a malformed report once while it stays in the window', async () => {
    const withRejected: ParsedReports = {
      reports: [report(5)],
      rejected: [{ index: 1, number: 4, paths: ['EarthquakeInfo'] }],
    };
    const { poller, warn } = setup(withRejected, withRejected, withRejected);

    await poller.poll();
    await poller.poll();
    await poller.poll();

    expect(warn).toHaveBeenCalledOnce();
  });

  it('keeps going when a publish throws', async () => {
    const { poller, publish, published, error } = setup(batch(1), batch(1, 2, 3));
    publish.mockRejectedValueOnce(new Error('boom'));

    await poller.poll();
    await expect(poller.poll()).resolves.toBeUndefined();

    expect(published()).toEqual([2, 3]);
    expect(error).toHaveBeenCalledOnce();
  });
});

describe('startReportPolling', () => {
  it('polls immediately, then once per interval after each poll settles', async () => {
    vi.useFakeTimers();
    const poll = vi.fn(async () => undefined);
    const { logger } = makeLogger();

    const handle = startReportPolling({ poll }, 60_000, logger);
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('keeps the loop alive when a poll throws', async () => {
    vi.useFakeTimers();
    const poll = vi.fn(async () => {
      throw new Error('unexpected');
    });
    const { logger, error } = makeLogger();

    const handle = startReportPolling({ poll }, 60_000, logger);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(poll).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalled();
    handle.stop();
  });

  it('leaves no timer behind after stop, even mid-poll', async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    const poll = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { logger } = makeLogger();

    const handle = startReportPolling({ poll }, 60_000, logger);
    handle.stop();
    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });
});
