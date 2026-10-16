/**
 * Parsing for the Central Weather Administration (CWA) "significant
 * earthquake report" dataset (`E-A0015-001`).
 *
 * The upstream is a government feed this bot does not control, so the
 * parse is tolerant at two levels:
 *   - the envelope must carry a `records.Earthquake` array, otherwise the
 *     whole response is unusable and the parse throws;
 *   - each report is validated on its own, so one malformed entry is
 *     reported back to the caller and skipped instead of hiding the rest.
 * Unknown fields are ignored everywhere (zod strips them), and optional
 * presentation fields (image, web link, colour) degrade to `undefined`
 * rather than rejecting the report.
 */
import { z } from 'zod';

/** One county's maximum observed intensity, exactly as the CWA labels it. */
interface CwaShakingArea {
  /** County name; a summary row may join several with a list separator. */
  readonly county: string;
  /** Intensity label such as `4級` or `5弱`. */
  readonly intensity: string;
}

/** A validated significant earthquake report, in the shape the plugin uses. */
export interface CwaReport {
  /** Monotonic report number (e.g. `115064`); the poller's cursor. */
  readonly number: number;
  /** CWA severity colour name (`ReportColor`), when present. */
  readonly color: string | undefined;
  readonly content: string;
  readonly imageUrl: string | undefined;
  readonly webUrl: string | undefined;
  /** Origin time as Unix epoch milliseconds. */
  readonly originTimeMs: number;
  readonly magnitude: number;
  readonly depthKm: number;
  readonly epicenter: string;
  readonly areas: readonly CwaShakingArea[];
}

/** A report entry that failed validation and was skipped. */
interface RejectedReport {
  /** Position in the upstream array. */
  readonly index: number;
  /** The entry's `EarthquakeNo`, when it carried a usable one. */
  readonly number: number | undefined;
  /** Dotted paths of the fields that failed validation. */
  readonly paths: readonly string[];
}

/** Outcome of parsing one response body. */
export interface ParsedReports {
  readonly reports: readonly CwaReport[];
  readonly rejected: readonly RejectedReport[];
}

/**
 * CWA timestamps are Taiwan time. The current feed carries an explicit
 * `+08:00` offset; a bare `YYYY-MM-DD hh:mm:ss` (the older format) gets
 * that offset added so it is never read as the host's local time.
 */
const BARE_LOCAL_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/;
const TAIWAN_OFFSET = '+08:00';

const toEpochMs = (raw: string): number => {
  const bare = BARE_LOCAL_TIME.exec(raw);
  const normalised = bare === null ? raw : `${bare[1]}T${bare[2]}${TAIWAN_OFFSET}`;
  return Date.parse(normalised);
};

/**
 * Discord accepts only http(s) URLs for embed links and images; anything
 * else becomes `undefined` so a bad link drops the decoration, not the
 * report.
 */
const optionalWebUrl = z
  .string()
  .url()
  .refine((v) => v.startsWith('https://') || v.startsWith('http://'))
  .optional()
  .catch(undefined);

const shakingAreaSchema = z.object({
  CountyName: z.string().min(1),
  AreaIntensity: z.string().min(1),
});

const reportSchema = z
  .object({
    EarthquakeNo: z.number().int().positive(),
    ReportColor: z.string().optional().catch(undefined),
    ReportContent: z.string().min(1),
    ReportImageURI: optionalWebUrl,
    Web: optionalWebUrl,
    EarthquakeInfo: z.object({
      OriginTime: z
        .string()
        .refine((v) => Number.isFinite(toEpochMs(v)), 'OriginTime is not a valid timestamp'),
      FocalDepth: z.number().nonnegative(),
      Epicenter: z.object({ Location: z.string().min(1) }),
      EarthquakeMagnitude: z.object({ MagnitudeValue: z.number() }),
    }),
    // A report with no intensity block is still worth publishing; it just
    // has no per-county list.
    Intensity: z
      .object({ ShakingArea: z.array(shakingAreaSchema) })
      .optional()
      .catch(undefined),
  })
  .transform(
    (raw): CwaReport => ({
      number: raw.EarthquakeNo,
      color: raw.ReportColor,
      content: raw.ReportContent,
      imageUrl: raw.ReportImageURI,
      webUrl: raw.Web,
      originTimeMs: toEpochMs(raw.EarthquakeInfo.OriginTime),
      magnitude: raw.EarthquakeInfo.EarthquakeMagnitude.MagnitudeValue,
      depthKm: raw.EarthquakeInfo.FocalDepth,
      epicenter: raw.EarthquakeInfo.Epicenter.Location,
      areas: (raw.Intensity?.ShakingArea ?? []).map((area) => ({
        county: area.CountyName,
        intensity: area.AreaIntensity,
      })),
    }),
  );

const envelopeSchema = z.object({
  records: z.object({ Earthquake: z.array(z.unknown()) }),
});

const numberOf = (entry: unknown): number | undefined => {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const value = (entry as { EarthquakeNo?: unknown }).EarthquakeNo;
  return typeof value === 'number' ? value : undefined;
};

/**
 * Parse one `E-A0015-001` response body.
 *
 * @throws {z.ZodError} when the envelope itself is unusable (no
 *   `records.Earthquake` array) — the caller treats that like any other
 *   failed poll.
 */
export const parseReportPayload = (raw: unknown): ParsedReports => {
  const envelope = envelopeSchema.parse(raw);
  const reports: CwaReport[] = [];
  const rejected: RejectedReport[] = [];
  envelope.records.Earthquake.forEach((entry, index) => {
    const parsed = reportSchema.safeParse(entry);
    if (parsed.success) {
      reports.push(parsed.data);
      return;
    }
    rejected.push({
      index,
      number: numberOf(entry),
      paths: parsed.error.issues.map((issue) => issue.path.join('.')),
    });
  });
  return { reports, rejected };
};
