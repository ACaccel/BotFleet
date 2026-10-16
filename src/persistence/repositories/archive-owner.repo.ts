import type { Types } from 'mongoose';
import { ARCHIVE_SCHEMA_VERSION } from '../../core/archive/types';
import type { ArchiveOwner, GuildConnection } from '../connection';
import { assertArchiveWriter } from './archive-mutation';

/** The archive owner lease and the structural maintenance done only after ownership. */
export interface ArchiveOwnerRepo {
  acquireOwner(ownerId: string, now: number): Promise<boolean>;
  releaseOwner(ownerId: string): Promise<void>;
  /** The stored owner lease, for proving a previous writer terminated. */
  ownerLease(): Promise<{ readonly id: unknown; readonly ownerId: unknown } | null>;
  /** Removes the lease `id` while it still names `ownerId`; `true` when removed. */
  releaseOwnerLease(id: unknown, ownerId: string): Promise<boolean>;
  /** Creates the archive collections and their indexes; called only after ownership. */
  ensureArchiveCollections(): Promise<void>;
  /**
   * Creates `messages` and `fetches` with their indexes after checking that the
   * stored messages are schema 3 with schema 3 indexes; throws when they are not.
   */
  prepareMessageCollections(): Promise<void>;
}
export class MongoArchiveOwnerRepo implements ArchiveOwnerRepo {
  public constructor(
    private readonly conn: GuildConnection,
    owner: ArchiveOwner,
  ) {
    assertArchiveWriter(conn, owner);
  }
  public async acquireOwner(ownerId: string, now: number): Promise<boolean> {
    const collection = this.conn.connection.collection<{
      _id: string;
      key: string;
      ownerId: string;
      acquiredAt: number;
    }>('archive_leases');
    try {
      const existing = await collection.findOne({ _id: 'owner' });
      if (existing) return existing.ownerId === ownerId;
      await collection.insertOne({ _id: 'owner', key: 'owner', ownerId, acquiredAt: now });
      return true;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000)
        return false;
      throw error;
    }
  }
  public async releaseOwner(ownerId: string): Promise<void> {
    await this.conn.connection
      .collection<{
        _id: string;
        key: string;
        ownerId: string;
        acquiredAt: number;
      }>('archive_leases')
      .deleteOne({ _id: 'owner', ownerId });
  }
  public async ownerLease(): Promise<{ readonly id: unknown; readonly ownerId: unknown } | null> {
    const previous = await this.conn.models.ArchiveLease.collection.findOne({ key: 'owner' });
    return previous === null ? null : { id: previous._id, ownerId: previous.ownerId };
  }
  public async releaseOwnerLease(id: unknown, ownerId: string): Promise<boolean> {
    const released = await this.conn.models.ArchiveLease.collection.deleteOne({
      // The stored ID is `'owner'` (see acquireOwner); the model's filter type knows only ObjectIds.
      _id: id as Types.ObjectId,
      ownerId,
    });
    return released.deletedCount === 1;
  }
  public async ensureArchiveCollections(): Promise<void> {
    for (const [name, model] of Object.entries(this.conn.models)) {
      if (name.startsWith('Archive')) {
        await model.createCollection();
        await model.createIndexes();
      }
    }
  }
  public async prepareMessageCollections(): Promise<void> {
    const { Message, Fetch } = this.conn.models;
    await Message.createCollection();
    const indexes = await Message.collection.indexes();
    const names = new Set(indexes.map((index) => index.name));
    if (
      names.has('messageId_1') ||
      (['createdTimestamp_1', 'channelId_1_createdTimestamp_1'].some((name) => !names.has(name)) &&
        (await Message.exists({})))
    ) {
      throw new Error('Existing messages require reviewed index capacity preflight');
    }
    if (await this.holdsEarlierSchema()) {
      throw new Error('Messages of an earlier schema require the archive rebuild');
    }
    await Message.createIndexes();
    await Fetch.createCollection();
    await Fetch.createIndexes();
  }
  /**
   * Whether `messages` still holds documents of an earlier schema. Schema 3 keys on
   * the string message ID and BSON orders strings before the ObjectIds and embedded
   * identities earlier schemas used, so the `_id` index bounds both checks.
   */
  private async holdsEarlierSchema(): Promise<boolean> {
    const messages = this.conn.connection.collection<{ _id: unknown; schemaVersion?: unknown }>(
      'messages',
    );
    const projection = { _id: 1, schemaVersion: 1 };
    const first = await messages.findOne({}, { sort: { _id: 1 }, projection });
    if (first === null) return false;
    const last = await messages.findOne({}, { sort: { _id: -1 }, projection });
    return [first, last].some(
      (document) =>
        typeof document?._id !== 'string' || document.schemaVersion !== ARCHIVE_SCHEMA_VERSION,
    );
  }
}
