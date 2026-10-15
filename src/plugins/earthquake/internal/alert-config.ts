/**
 * The `earthquake_alert` block of nijika's `config.json`: operator settings
 * for early-warning messages. Absent means the defaults; a malformed block
 * stops startup.
 */
import { z } from 'zod';

import { INTENSITIES, type Intensity } from './alert-request';

/** Exported for the deployment preflight, which checks the block before cutover. */
export const EarthquakeAlertConfigSchema = z
  .object({
    /** Lowest local intensity that pings the guild's `earthquake` role and turns the embed red. */
    ping_min_local_intensity: z.enum(INTENSITIES).default('4'),
  })
  .strict();

export interface EarthquakeAlertSettings {
  readonly pingMinLocalIntensity: Intensity;
}

/** Parse the block; throws a message naming the offending field when it is malformed. */
export const parseEarthquakeAlertConfig = (raw: unknown): EarthquakeAlertSettings => {
  const parsed = EarthquakeAlertConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${['earthquake_alert', ...issue.path].join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid earthquake_alert config (${problems})`);
  }
  return { pingMinLocalIntensity: parsed.data.ping_min_local_intensity };
};
