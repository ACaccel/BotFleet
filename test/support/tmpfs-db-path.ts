/**
 * Data directory for an in-memory MongoDB, preferably on tmpfs.
 *
 * Suites create and drop databases constantly; on a disk-backed
 * directory the storage-engine fsyncs dominate the run (measured:
 * integration project 157s on disk, 49s on tmpfs). `/dev/shm` is a
 * RAM-backed tmpfs on Linux. Where it is missing or not writable
 * (macOS) callers fall back to the server's default temporary directory.
 */
import { accessSync, constants, mkdtempSync } from 'node:fs';
import { join } from 'node:path';

const TMPFS_ROOT = '/dev/shm';

/**
 * A fresh data directory on tmpfs, or `undefined` when tmpfs is
 * unusable. The caller owns removal: a caller-supplied `dbPath` is not
 * deleted by `MongoMemoryServer.stop`.
 */
export const createTmpfsDbPath = (): string | undefined => {
  try {
    accessSync(TMPFS_ROOT, constants.W_OK);
    return mkdtempSync(join(TMPFS_ROOT, 'pleiades-int-mongo-'));
  } catch {
    return undefined;
  }
};
