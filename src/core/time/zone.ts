/** Milliseconds the zone is ahead of UTC at `atMs`. */
export const zoneOffsetMs = (timeZone: string, atMs: number): number => {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  });
  for (const part of format.formatToParts(atMs)) parts[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
  );
  return asUtc - Math.floor(atMs / 60_000) * 60_000;
};

/** The instant a wall-clock time in `timeZone` names; two passes settle daylight-saving edges. */
export const zonedTimeToEpoch = (
  wall: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): number => {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const first = guess - zoneOffsetMs(timeZone, guess);
  return guess - zoneOffsetMs(timeZone, first);
};
