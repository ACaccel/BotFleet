import { Types } from 'mongoose';
import type { ArchiveChannel } from '../../core/archive/types';
import type { ArchiveOwner, GuildConnection } from '../connection';
import {
  assertArchiveWriter,
  writeArchiveDocument,
  type ArchiveMutationContext,
  type StoredDocument,
} from './archive-mutation';

/**
 * A live channel observation: the given fields replace the stored ones and the rest
 * (checkpoints, discovery) stay. `parentId: null` removes the parent. `access`
 * always applies; `initialAccess` (default `unknown`) only to a new record.
 */
export interface ArchiveChannelUpdate {
  readonly channelId: string;
  readonly observedAt: number;
  readonly name?: string;
  readonly type?: number;
  readonly parentId?: string | null;
  readonly access?: ArchiveChannel['access'];
  readonly initialAccess?: ArchiveChannel['access'];
  readonly everyoneCanView?: boolean;
}
/** `archive_channels` records and the `fetches` newest-message cursor of each channel. */
export interface ArchiveChannelRepo {
  upsertChannel(channel: ArchiveChannel, context?: ArchiveMutationContext): Promise<void>;
  recordChannel(update: ArchiveChannelUpdate, context?: ArchiveMutationContext): Promise<void>;
  listChannels(): Promise<ArchiveChannel[]>;
  findChannel(channelId: string): Promise<ArchiveChannel | null>;
  channelAccess(channelId: string): Promise<Pick<ArchiveChannel, 'access'> | null>;
  channelParent(channelId: string): Promise<Pick<ArchiveChannel, 'parentId'> | null>;
  /** Channel IDs `archive_channels` holds. */
  listChannelIds(): Promise<string[]>;
  /** Channel IDs with a `fetches` cursor. */
  fetchChannelIds(): Promise<string[]>;
  /** The newest-message cursor of a channel. */
  fetchCursor(channelId: string): Promise<string | undefined>;
  /** Moves the channel's cursor forward to `latest`; never backward. */
  advanceFetchCursor(channelId: string, name: string, latest: string): Promise<void>;
}
export class MongoArchiveChannelRepo implements ArchiveChannelRepo {
  public constructor(
    private readonly conn: GuildConnection,
    owner: ArchiveOwner,
  ) {
    assertArchiveWriter(conn, owner);
  }
  /**
   * Writes a scan's view of a channel. The record is authoritative for the parent:
   * a channel without `parentId` has none. Each scan kind writes only its own
   * checkpoint; other stored fields stay.
   */
  public async upsertChannel(
    channel: ArchiveChannel,
    context?: ArchiveMutationContext,
  ): Promise<void> {
    const before = await this.conn.models.ArchiveChannel.collection.findOne({
      channelId: channel.channelId,
    });
    const checkpoints = {
      ...(before?.['checkpoints'] as ArchiveChannel['checkpoints']),
      ...channel.checkpoints,
    };
    const after: Record<string, unknown> = {
      ...before,
      ...channel,
      ...(Object.keys(checkpoints).length === 0 ? {} : { checkpoints }),
    };
    if (channel.parentId === undefined) delete after['parentId'];
    await this.mutate('archive_channels', before, after, 'channel-checkpoint', context);
  }
  public async recordChannel(
    update: ArchiveChannelUpdate,
    context?: ArchiveMutationContext,
  ): Promise<void> {
    const before = await this.conn.models.ArchiveChannel.collection.findOne({
      channelId: update.channelId,
    });
    const { parentId, initialAccess, ...fields } = update;
    const after: Record<string, unknown> = {
      ...(before ?? { channelId: update.channelId, access: initialAccess ?? 'unknown' }),
      ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    };
    if (parentId === null) delete after['parentId'];
    else if (parentId !== undefined) after['parentId'] = parentId;
    await this.mutate('archive_channels', before, after, 'channel-event', context);
  }
  public async listChannels(): Promise<ArchiveChannel[]> {
    return this.conn.models.ArchiveChannel.find({}).lean<ArchiveChannel[]>().exec();
  }
  public async findChannel(channelId: string): Promise<ArchiveChannel | null> {
    return this.conn.models.ArchiveChannel.findOne({ channelId }).lean<ArchiveChannel>().exec();
  }
  public async channelAccess(channelId: string): Promise<Pick<ArchiveChannel, 'access'> | null> {
    return this.conn.models.ArchiveChannel.findOne({ channelId }, { access: 1 })
      .lean<Pick<ArchiveChannel, 'access'>>()
      .exec();
  }
  public async channelParent(channelId: string): Promise<Pick<ArchiveChannel, 'parentId'> | null> {
    return this.conn.models.ArchiveChannel.findOne({ channelId }, { parentId: 1 })
      .lean<Pick<ArchiveChannel, 'parentId'>>()
      .exec();
  }
  public async listChannelIds(): Promise<string[]> {
    return (await this.conn.models.ArchiveChannel.distinct('channelId').exec()).filter(
      (id): id is string => typeof id === 'string',
    );
  }
  public async fetchChannelIds(): Promise<string[]> {
    return (await this.conn.models.Fetch.distinct('channelID').exec()).filter(
      (id): id is string => typeof id === 'string',
    );
  }
  public async fetchCursor(channelId: string): Promise<string | undefined> {
    const cursor = await this.conn.models.Fetch.findOne({ channelID: channelId }).lean().exec();
    return cursor?.lastMessageID ? cursor.lastMessageID : undefined;
  }
  public async advanceFetchCursor(channelId: string, name: string, latest: string): Promise<void> {
    const collection = this.conn.models.Fetch.collection;
    const before = await collection.findOne({ channelID: channelId });
    const old = typeof before?.lastMessageID === 'string' ? before.lastMessageID : '';
    if (/^\d+$/.test(old) && BigInt(old) >= BigInt(latest)) return;
    const after = {
      ...before,
      _id: before?._id ?? new Types.ObjectId(),
      channelID: channelId,
      channel: name,
      lastMessageID: latest,
    };
    if (before === null) await collection.insertOne(after);
    else await collection.replaceOne({ _id: before._id }, after);
  }
  private async mutate(
    collection: string,
    before: StoredDocument | null,
    after: StoredDocument | null,
    reason: string,
    context?: ArchiveMutationContext,
  ): Promise<void> {
    await writeArchiveDocument(this.conn, collection, before, after, reason, context);
  }
}
