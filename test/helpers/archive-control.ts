import type { Connection } from 'mongoose';
import { archiveControlFactory, type ArchiveControl } from '../../src/application/archive/control';
import { buildArchiveRepos } from '../../src/persistence/repositories/archive-repos';
import { asGuildId } from '../../src/core/ids';
import type { GuildConnection, GuildModels } from '../../src/persistence/connection';

/**
 * Archive control over a test database, built through the same factory the
 * msg-archive root binds. The guild connection reuses the models a worker or
 * connection manager already compiled on `connection`; control itself reads
 * only the raw connection.
 */
export const archiveControlFor = async (
  connection: Connection,
  guildId = '1',
  defaultIntervalMs = 60_000,
): Promise<ArchiveControl> => {
  const guild: GuildConnection = {
    guildId: asGuildId(guildId),
    connection,
    models: connection.models as unknown as GuildModels,
    archiveOwner: 'msg-archive',
  };
  return archiveControlFactory(buildArchiveRepos)({ guild, defaultIntervalMs });
};
