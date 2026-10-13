/**
 * Format a `Date` as `YYYY-MM-DD_HH-MM-SS` in the host's local timezone.
 *
 * Meant for file and directory names: fields are zero-padded and ordered
 * most- to least-significant, so names sort chronologically, and colons
 * are avoided so the result is a valid segment on every platform.
 * `getMonth()` is 0-based, hence the `+1`.
 */
export const formatFileStamp = (now: Date): string => {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const date = `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `${date}_${time}`;
};
