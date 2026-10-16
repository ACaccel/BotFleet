/**
 * The per-guild connection every repository receives.
 *
 * Declared in `persistence/` because repositories consume it: the contract names
 * only mongoose and the schema registry, both persistence concerns. Acquiring and
 * closing connections stays in `infra/mongo`, which builds values of this type, so
 * persistence never depends on the SDK lifecycle layer above it.
 */
import type { Connection, Model } from 'mongoose';
import type { GuildId } from '../core/ids';
import type { DocByName, SchemaName } from './schemas';

/** Typed model registry for one guild connection. */
export type GuildModels = {
  readonly [K in SchemaName]: Model<DocByName[K]>;
};

/** The only bot that may write the message archive. */
export type ArchiveOwner = 'msg-archive';

export interface GuildConnection {
  readonly guildId: GuildId;
  readonly connection: Connection;
  readonly models: GuildModels;
  readonly archiveOwner?: ArchiveOwner;
}
