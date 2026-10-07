import { hostname } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GuildConnection } from '../../../../src/infra/mongo/connection-manager';
import { releaseTerminatedArchiveOwner } from '../../../../src/infra/archive/owner';

const fixture = (ownerId: string, inprog: unknown = []) => {
  const deleteOne = vi.fn(async () => ({ deletedCount: 1 }));
  const command = vi.fn(async () => ({ inprog }));
  const connection = {
    archiveOwner: 'msg-archive',
    models: {
      ArchiveLease: { collection: { findOne: async () => ({ _id: 'lease', ownerId }), deleteOne } },
    },
    connection: { db: { admin: () => ({ command }) } },
  } as unknown as GuildConnection;
  return { connection, deleteOne, command };
};

afterEach(() => vi.restoreAllMocks());
describe('archive owner recovery', () => {
  it('requires process termination and server-side drainage before a conditional release', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    const ownerId = `${hostname()}:12345:old`;
    const { connection, command, deleteOne } = fixture(ownerId);
    expect(await releaseTerminatedArchiveOwner(connection)).toBe(true);
    expect(command).toHaveBeenCalledWith({
      currentOp: 1,
      $all: true,
      'clientMetadata.application.name': ownerId,
    });
    expect(deleteOne).toHaveBeenCalledWith({ _id: 'lease', ownerId });
  });
  it('never releases a live process or an unverifiable remote host', async () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const local = fixture(`${hostname()}:12345:old`);
    expect(await releaseTerminatedArchiveOwner(local.connection)).toBe(false);
    expect(local.command).not.toHaveBeenCalled();
    const remote = fixture('remote-host:12345:old');
    expect(await releaseTerminatedArchiveOwner(remote.connection)).toBe(false);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(remote.deleteOne).not.toHaveBeenCalled();
  });
  it('retains ownership if the dead process still has a server operation', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    const { connection, deleteOne } = fixture(`${hostname()}:12345:old`, [{ opid: 1 }]);
    expect(await releaseTerminatedArchiveOwner(connection)).toBe(false);
    expect(deleteOne).not.toHaveBeenCalled();
  });
  it('fails closed on missing server-side verification permission', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    const { connection, deleteOne, command } = fixture(`${hostname()}:12345:old`);
    command.mockRejectedValue(new Error('unauthorized'));
    await expect(releaseTerminatedArchiveOwner(connection)).rejects.toThrow('unauthorized');
    expect(deleteOne).not.toHaveBeenCalled();
  });
});
