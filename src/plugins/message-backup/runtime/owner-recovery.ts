import { archiveProcessExited } from '../../../infra/archive/owner';
import { clientOperations } from '../../../infra/mongo/admin';
import type { GuildConnection } from '../../../persistence/connection';
import type { ArchiveOwnerRepo } from '../../../persistence/repositories/archive-owner.repo';

/**
 * Releases the owner lease of a previous archive writer only on proof that it
 * stopped: its process no longer exists on this host and the server runs nothing
 * for it. A timeout alone is never evidence that the prior writer has stopped.
 */
export const releaseTerminatedArchiveOwner = async (
  connection: GuildConnection,
  leases: Pick<ArchiveOwnerRepo, 'ownerLease' | 'releaseOwnerLease'>,
): Promise<boolean> => {
  if (connection.archiveOwner !== 'msg-archive')
    throw new Error('Archive recovery requires msg-archive');
  const previous = await leases.ownerLease();
  if (previous === null) return true;
  if (typeof previous.ownerId !== 'string') return false;
  if (!archiveProcessExited(previous.ownerId)) return false;
  const db = connection.connection.db;
  if (db === undefined) return false;
  // Require server-side evidence too: a dead process may have left work running.
  // Lack of permission fails closed and must be resolved by the operator.
  const operations = await clientOperations(db, previous.ownerId);
  if (operations === undefined || operations.length !== 0) return false;
  return leases.releaseOwnerLease(previous.id, previous.ownerId);
};
