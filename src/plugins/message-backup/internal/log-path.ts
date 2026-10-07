/**
 * Filesystem path construction for the per-guild backup transcript.
 *
 * The transcript is opened with `'w'` (truncate) by {@link BackupLog},
 * so a fixed filename would let each backup pass overwrite the prior
 * run's artifact. Embedding a local-time `YYYY-MM-DD_HH-MM-SS` stamp in
 * the filename keeps every run's transcript on disk for later auditing.
 */
import * as path from 'node:path';

/**
 * Format a `Date` as `YYYY-MM-DD_HH-MM-SS` in the operator's local
 * timezone. Colons are deliberately avoided so the result is a valid
 * filename segment on every platform. `getMonth()` is 0-based, hence
 * the `+1`.
 */
export const formatBackupStamp = (now: Date): string => {
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${y}-${mo}-${d}_${h}-${mi}-${s}`;
};

/**
 * Build the absolute path for a guild's backup transcript under
 * `<cwd>/logs/backup/msg-archive-<guildId>-<stamp>.log`. The parent
 * directory is created by {@link BackupLog}'s constructor.
 */
export const buildBackupLogPath = (guildId: string, now: Date): string =>
  path.join(
    process.cwd(),
    'logs',
    'backup',
    `msg-archive-${guildId}-${formatBackupStamp(now)}.log`,
  );
