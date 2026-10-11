import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

/**
 * Identifies this process as the archive writer: `<host>:<pid>:<uuid>`. It is the
 * owner lease's `ownerId` and the MongoDB client's application name, so a later
 * process can look for both.
 */
export const ARCHIVE_PROCESS_ID = `${hostname()}:${process.pid}:${randomUUID()}`;

/**
 * Whether `ownerId` (an {@link ARCHIVE_PROCESS_ID}) names a process on this host
 * that no longer exists. Another host, a malformed ID, a live process or one this
 * process may not signal all answer `false`.
 */
export const archiveProcessExited = (ownerId: string): boolean => {
  const parts = ownerId.split(':');
  if (parts.length !== 3 || parts[0] !== hostname() || !/^\d+$/.test(parts[1] ?? '')) return false;
  const pid = Number(parts[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
  }
};
