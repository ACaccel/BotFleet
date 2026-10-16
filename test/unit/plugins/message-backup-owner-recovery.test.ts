import { hostname } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GuildConnection } from '../../../src/persistence/connection';
import { releaseTerminatedArchiveOwner } from '../../../src/plugins/message-backup/runtime/owner-recovery';

const fixture = (
  ownerId: unknown,
  inprog: unknown = [],
  options: { db?: boolean; lease?: boolean; owner?: 'msg-archive' } = {},
) => {
  const deleteOne = vi.fn(async () => true);
  const command = vi.fn(async () => ({ inprog }));
  const connection = {
    archiveOwner: 'owner' in options ? options.owner : 'msg-archive',
    connection: { db: options.db === false ? undefined : { admin: () => ({ command }) } },
  } as unknown as GuildConnection;
  const leases = {
    ownerLease: async () => (options.lease === false ? null : { id: 'lease', ownerId }),
    releaseOwnerLease: deleteOne,
  };
  const release = () => releaseTerminatedArchiveOwner(connection, leases);
  return { release, deleteOne, command };
};

afterEach(() => vi.restoreAllMocks());
describe('archive owner recovery', () => {
  it('requires process termination and server-side drainage before a conditional release', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    const ownerId = `${hostname()}:12345:old`;
    const { release, command, deleteOne } = fixture(ownerId);
    expect(await release()).toBe(true);
    expect(command).toHaveBeenCalledWith({
      currentOp: 1,
      $all: true,
      'clientMetadata.application.name': ownerId,
    });
    expect(deleteOne).toHaveBeenCalledWith('lease', ownerId);
  });
  it('never releases a live process or an unverifiable remote host', async () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const local = fixture(`${hostname()}:12345:old`);
    expect(await local.release()).toBe(false);
    expect(local.command).not.toHaveBeenCalled();
    const remote = fixture('remote-host:12345:old');
    expect(await remote.release()).toBe(false);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(remote.deleteOne).not.toHaveBeenCalled();
  });
  it('retains ownership if the dead process still has a server operation', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    const { release, deleteOne } = fixture(`${hostname()}:12345:old`, [{ opid: 1 }]);
    expect(await release()).toBe(false);
    expect(deleteOne).not.toHaveBeenCalled();
  });
  it('fails closed on missing server-side verification permission', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    const { release, deleteOne, command } = fixture(`${hostname()}:12345:old`);
    command.mockRejectedValue(new Error('unauthorized'));
    await expect(release()).rejects.toThrow('unauthorized');
    expect(deleteOne).not.toHaveBeenCalled();
  });
  const gone = () =>
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
  const local = `${hostname()}:12345:old`;

  it('is reserved for the archive owner and succeeds when no lease is recorded', async () => {
    await expect(fixture(local, [], { owner: undefined }).release()).rejects.toThrow(
      'Archive recovery requires msg-archive',
    );
    const empty = fixture(local, [], { lease: false });
    expect(await empty.release()).toBe(true);
    expect(empty.deleteOne).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-string owner', 42],
    ['a malformed owner', `${hostname()}:old`],
    ['a non-numeric process ID', `${hostname()}:abc:old`],
    ['an unsafe process ID', `${hostname()}:99999999999999999999:old`],
  ])('keeps %s', async (_case, ownerId) => {
    gone();
    const target = fixture(ownerId);
    expect(await target.release()).toBe(false);
    expect(target.command).not.toHaveBeenCalled();
  });

  it('keeps a lease whose process cannot be signalled for another reason', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    expect(await fixture(local).release()).toBe(false);
  });

  it('keeps a lease without a database or a readable operation list', async () => {
    gone();
    expect(await fixture(local, [], { db: false }).release()).toBe(false);
    const unreadable = fixture(local, 'not-a-list');
    expect(await unreadable.release()).toBe(false);
    expect(unreadable.deleteOne).not.toHaveBeenCalled();
  });
});
