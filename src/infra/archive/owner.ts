import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Connection } from 'mongoose';
import type { GuildConnection } from '../mongo/connection-manager';

export const ARCHIVE_PROCESS_ID = `${hostname()}:${process.pid}:${randomUUID()}`;

/** A timeout alone is never evidence that the prior writer has stopped. */
export const releaseTerminatedArchiveOwner = async (
  connection: GuildConnection,
): Promise<boolean> => {
  if (connection.archiveOwner !== 'msg-archive')
    throw new Error('Archive recovery requires msg-archive');
  const leases = connection.models.ArchiveLease.collection;
  const previous = await leases.findOne({ key: 'owner' });
  if (previous === null) return true;
  if (typeof previous.ownerId !== 'string') return false;
  if (!(await isTerminatedArchiveProcess(connection.connection, previous.ownerId))) return false;
  const released = await leases.deleteOne({ _id: previous._id, ownerId: previous.ownerId });
  return released.deletedCount === 1;
};

/** Startup recovery must prove both client termination and server-side drainage. */
export const isTerminatedArchiveProcess = async (
  connection: Connection,
  ownerId: string,
): Promise<boolean> => {
  const parts = ownerId.split(':');
  if (parts.length !== 3 || parts[0] !== hostname() || !/^\d+$/.test(parts[1] ?? '')) return false;
  const pid = Number(parts[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH'))
      return false;
  }
  const db = connection.db;
  if (db === undefined) return false;
  // Require server-side evidence too: a dead process may have left work running.
  // Lack of permission fails closed and must be resolved by the operator.
  const active: unknown = await db
    .admin()
    .command({ currentOp: 1, $all: true, 'clientMetadata.application.name': ownerId });
  const operations = active as { inprog?: unknown };
  if (!Array.isArray(operations.inprog) || operations.inprog.length !== 0) return false;
  return true;
};
