/**
 * The request contract of `POST /alerts`: one early-warning alert as the
 * Windows caller script builds it from the warning app's arguments.
 */
import { z } from 'zod';

/** The Central Weather Administration intensity scale, weakest first. */
export const INTENSITIES = ['0', '1', '2', '3', '4', '5-', '5+', '6-', '6+', '7'] as const;

export type Intensity = (typeof INTENSITIES)[number];

/** Whether `intensity` is at or above `threshold` on the CWA scale. */
export const intensityAtLeast = (intensity: Intensity, threshold: Intensity): boolean =>
  INTENSITIES.indexOf(intensity) >= INTENSITIES.indexOf(threshold);

/**
 * How far `remainingSeconds` may fall below zero. Inside the blind zone, or
 * for an update issued after the S-wave arrived, the app can report a
 * countdown that has already run out; rejecting it would drop a live alert.
 * The field only feeds logs (the message counts down from `arrivalTime`),
 * so the bound merely rejects nonsense.
 */
const REMAINING_SECONDS_BOUND = 600;

const finite = (min: number, max: number) => z.number().finite().min(min).max(max);

export const EarthquakeAlertSchema = z
  .object({
    epicenterLat: finite(-90, 90),
    epicenterLon: finite(-180, 180),
    depthKm: finite(0, 1000),
    magnitude: finite(0, 10),
    maxIntensity: z.enum(INTENSITIES),
    localIntensity: z.enum(INTENSITIES),
    /** Local S-wave arrival, Unix seconds. */
    arrivalTime: z.number().int().nonnegative(),
    /** Seconds until the S-wave arrives locally, as the app counted them. */
    remainingSeconds: z.number().int().min(-REMAINING_SECONDS_BOUND).max(REMAINING_SECONDS_BOUND),
  })
  .strict();

export type EarthquakeAlert = z.infer<typeof EarthquakeAlertSchema>;

/**
 * The fixed values the warning app sends from its test button. The app stamps
 * the arrival time with the current clock, so only these values identify a
 * test; a real alert matching every one of them is not plausible.
 */
export const APP_TEST_ALERT = {
  epicenterLat: 23.85,
  epicenterLon: 120.82,
  depthKm: 10,
  magnitude: 7.3,
  maxIntensity: '7',
  localIntensity: '5+',
  remainingSeconds: 20,
} as const satisfies Partial<EarthquakeAlert>;

/** Whether `alert` carries exactly the warning app's test-button values. */
export const isAppTestAlert = (alert: EarthquakeAlert): boolean =>
  (Object.keys(APP_TEST_ALERT) as (keyof typeof APP_TEST_ALERT)[]).every(
    (field) => alert[field] === APP_TEST_ALERT[field],
  );
