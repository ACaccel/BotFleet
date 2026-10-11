import { Types, mongo } from 'mongoose';
import type { ArchiveMessage } from '../../core/archive/types';
import type { ArchiveOwner, GuildConnection } from '../connection';

export type ArchiveMutationInterceptor = (
  collection: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  reason: string,
) => Promise<void>;
export interface ArchiveMutationContext {
  readonly interceptor?: ArchiveMutationInterceptor;
}
/** A raw `messages` document; the archive writer stores them without mongoose casting. */
export type ArchiveMessageDocument = ArchiveMessage & Record<string, unknown>;
/** Any raw archive document; `_id` is a message ID or an ObjectId. */
export type StoredDocument = object;

/** The BSON size of a document as the archive stores it, for batch and reservation limits. */
export const archiveDocumentBytes = (document: object): number =>
  mongo.BSON.calculateObjectSize(document);

/** Archive writes require the msg-archive connection and capability. */
export const assertArchiveWriter = (conn: GuildConnection, owner: ArchiveOwner): void => {
  if (owner !== 'msg-archive' || conn.archiveOwner !== 'msg-archive')
    throw new Error('Archive writes require msg-archive ownership');
};

/** The raw `messages` collection. */
export const archiveMessages = (conn: GuildConnection): mongo.Collection<ArchiveMessageDocument> =>
  conn.connection.collection<ArchiveMessageDocument>('messages');

/**
 * Writes one archive document. A replacement or deletion is fenced on the full
 * before-image, so a concurrent change fails it; an interceptor receives the
 * mutation instead of the database.
 */
export const writeArchiveDocument = async (
  conn: GuildConnection,
  collection: string,
  beforeImage: StoredDocument | null,
  afterImage: StoredDocument | null,
  reason: string,
  context?: ArchiveMutationContext,
): Promise<void> => {
  const before = beforeImage as Record<string, unknown> | null;
  let after = afterImage as Record<string, unknown> | null;
  if (after && (before === null || after._id === undefined)) {
    // MongoDB stores _id first; keep the same BSON order so before-images compare equal.
    const { _id, ...fields } = after;
    after = { _id: _id ?? new Types.ObjectId(), ...fields };
  }
  if (after && mongo.BSON.calculateObjectSize(after) > 15 * 1024 * 1024)
    throw new Error('Archive document exceeds safe BSON limit');
  const interceptor = context?.interceptor;
  if (interceptor) {
    await interceptor(collection, before, after, reason);
    return;
  }
  // Messages key on the Discord message ID; the other archive collections on ObjectIds.
  const target = conn.connection.collection(collection);
  if (before) {
    // Replacements and deletions both require the exact observed image.
    const fence = {
      _id: before._id,
      $expr: { $eq: ['$$ROOT', { $literal: before }] },
    } as mongo.Filter<mongo.Document>;
    const update = after === null ? undefined : metadataUpdate(before, after);
    const result =
      after === null
        ? await target.deleteOne(fence)
        : update === undefined
          ? await target.replaceOne(fence, after)
          : await target.updateOne(fence, update);
    if (('matchedCount' in result ? result.matchedCount : result.deletedCount) !== 1)
      throw new Error('Archive write conflict');
  } else if (after) await target.insertOne(after);
};

export const sameArchiveDocument = (left: object, right: object): boolean =>
  Buffer.compare(
    Buffer.from(mongo.BSON.serialize(left)),
    Buffer.from(mongo.BSON.serialize(right)),
  ) === 0;
export const withoutMetadata = (message: ArchiveMessage): Record<string, unknown> =>
  Object.fromEntries(Object.entries(message).filter(([key]) => !METADATA_FIELDS.has(key)));
/** Backup metadata a re-observation or reaction refresh changes without touching content. */
const METADATA_FIELDS: ReadonlySet<string> = new Set([
  'observedAt',
  'reactionGenerations',
  'reactionsFreshAt',
  'reactionsStaleAt',
] as const satisfies readonly (keyof ArchiveMessage)[]);
/**
 * The `$set`/`$unset` that turns `before` into `after` when they differ only in
 * existing metadata fields, so the write does not resend the whole document. It is
 * used under the same full before-image fence as a replacement and leaves the same
 * document: no field is added and the remaining fields keep their order. Anything
 * else is `undefined` and is written as a replacement.
 */
export const metadataUpdate = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { $set?: Record<string, unknown>; $unset?: Record<string, 1> } | undefined => {
  const kept = Object.keys(before).filter((key) => key in after);
  const keys = Object.keys(after);
  if (keys.length !== kept.length || keys.some((key, index) => key !== kept[index]))
    return undefined;
  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};
  for (const key of Object.keys(before)) {
    if (!(key in after)) {
      if (!METADATA_FIELDS.has(key)) return undefined;
      unset[key] = 1;
    } else if (!sameArchiveDocument({ value: before[key] }, { value: after[key] })) {
      if (!METADATA_FIELDS.has(key)) return undefined;
      set[key] = after[key];
    }
  }
  if (Object.keys(set).length === 0 && Object.keys(unset).length === 0) return undefined;
  return {
    ...(Object.keys(set).length === 0 ? {} : { $set: set }),
    ...(Object.keys(unset).length === 0 ? {} : { $unset: unset }),
  };
};
