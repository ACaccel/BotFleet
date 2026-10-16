/**
 * Renders a CWA significant earthquake report as a Discord embed.
 *
 * Labels come from the translator; the report's own text (content,
 * epicenter, county names, intensity labels) is upstream data and is
 * shown as published. Every variable-length part is capped so the embed
 * stays inside Discord's per-field and 6000-character total limits.
 */
import { EmbedBuilder } from 'discord.js';

import type { Translator } from '../../../core/i18n';
import { EARTHQUAKE_REPORT_COLORS, EMBED_COLORS } from '../../../infra/discord/presentation-colors';
import type { CwaReport } from './cwa-report';

/**
 * Discord caps a field value at 1024 characters. The description cap is
 * set well under Discord's 4096 so description plus the two
 * variable-length fields can never exceed the 6000-character embed total.
 */
const FIELD_VALUE_MAX = 1024;
const DESCRIPTION_MAX = 2048;
/** Space kept free at the end of the intensity list for its overflow line. */
const OVERFLOW_LINE_RESERVE = 64;

/** `ReportColor` values the CWA publishes, mapped to embed accents. */
const REPORT_COLOR_BY_NAME: Readonly<Record<string, number>> = {
  // i18n-ignore: CWA API enum value (green), matched against upstream data
  綠色: EARTHQUAKE_REPORT_COLORS.green,
  // i18n-ignore: CWA API enum value (yellow), matched against upstream data
  黃色: EARTHQUAKE_REPORT_COLORS.yellow,
  // i18n-ignore: CWA API enum value (orange), matched against upstream data
  橙色: EARTHQUAKE_REPORT_COLORS.orange,
  // i18n-ignore: CWA API enum value (red), matched against upstream data
  紅色: EARTHQUAKE_REPORT_COLORS.red,
};

/**
 * Separators the CWA uses when one summary row lists several counties.
 */
// i18n-ignore: CJK list separators found in upstream county data
const COUNTY_SEPARATOR = /[、,，]/;

/** Suffix marking the upper half of a split intensity level (`5強`). */
// i18n-ignore: CWA intensity suffix, matched against upstream data
const UPPER_LEVEL_SUFFIX = '強';

/**
 * Sort key for a CWA intensity label. Levels 5 and 6 are split into a
 * lower (`弱`) and upper (`強`) half, so each level takes two slots;
 * an unrecognised label sorts last.
 */
export const intensityRank = (label: string): number => {
  const level = /^(\d)/.exec(label.trim());
  if (level === null) return -1;
  return Number(level[1]) * 2 + (label.includes(UPPER_LEVEL_SUFFIX) ? 1 : 0);
};

/** One county's strongest intensity across every row of the report. */
interface CountyIntensity {
  readonly county: string;
  readonly intensity: string;
}

/**
 * Fold the report's shaking areas into one entry per county with its
 * strongest intensity, strongest first. The feed mixes per-county rows
 * with summary rows that join several counties, so both are split and
 * merged rather than trusting either kind to be complete.
 */
export const summariseCountyIntensities = (
  areas: CwaReport['areas'],
): readonly CountyIntensity[] => {
  const strongest = new Map<string, string>();
  for (const area of areas) {
    for (const raw of area.county.split(COUNTY_SEPARATOR)) {
      const county = raw.trim();
      if (county.length === 0) continue;
      const current = strongest.get(county);
      if (current === undefined || intensityRank(area.intensity) > intensityRank(current)) {
        strongest.set(county, area.intensity);
      }
    }
  }
  // Stable sort keeps the upstream order among counties at the same level.
  return [...strongest]
    .map(([county, intensity]) => ({ county, intensity }))
    .sort((a, b) => intensityRank(b.intensity) - intensityRank(a.intensity));
};

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** Render the intensity list, ending in an overflow line when it does not fit. */
const formatIntensityList = (
  entries: readonly CountyIntensity[],
  translator: Translator,
): string => {
  const lines: string[] = [];
  let length = 0;
  for (const [index, entry] of entries.entries()) {
    const line = `${entry.county} ${entry.intensity}`;
    const nextLength = length + line.length + (lines.length > 0 ? 1 : 0);
    if (nextLength > FIELD_VALUE_MAX - OVERFLOW_LINE_RESERVE) {
      lines.push(
        translator.t('replies:earthquake.report.intensity_more', {
          count: entries.length - index,
        }),
      );
      break;
    }
    lines.push(line);
    length = nextLength;
  }
  return truncate(lines.join('\n'), FIELD_VALUE_MAX);
};

/** Build the embed for one report in the bot's configured language. */
export const buildReportEmbed = (report: CwaReport, translator: Translator): EmbedBuilder => {
  const unixSeconds = Math.floor(report.originTimeMs / 1000);
  const embed = new EmbedBuilder()
    .setTitle(translator.t('replies:earthquake.report.title', { number: report.number }))
    .setDescription(truncate(report.content, DESCRIPTION_MAX))
    .setColor(
      (report.color === undefined ? undefined : REPORT_COLOR_BY_NAME[report.color]) ??
        EMBED_COLORS.info,
    )
    .addFields(
      {
        name: translator.t('replies:earthquake.report.origin_time'),
        value: `<t:${unixSeconds}:F>`,
        inline: true,
      },
      {
        name: translator.t('replies:earthquake.report.magnitude'),
        value: report.magnitude.toFixed(1),
        inline: true,
      },
      {
        name: translator.t('replies:earthquake.report.depth'),
        value: translator.t('replies:earthquake.report.depth_value', { depth: report.depthKm }),
        inline: true,
      },
      {
        name: translator.t('replies:earthquake.report.epicenter'),
        // The feed pads distances with runs of spaces.
        value: truncate(report.epicenter.replace(/\s+/g, ' ').trim(), FIELD_VALUE_MAX),
      },
    )
    .setFooter({ text: translator.t('replies:earthquake.report.footer') })
    .setTimestamp(report.originTimeMs);

  const counties = summariseCountyIntensities(report.areas);
  if (counties.length > 0) {
    embed.addFields({
      name: translator.t('replies:earthquake.report.intensity'),
      value: formatIntensityList(counties, translator),
    });
  }
  if (report.webUrl !== undefined) embed.setURL(report.webUrl);
  if (report.imageUrl !== undefined) embed.setImage(report.imageUrl);
  return embed;
};
