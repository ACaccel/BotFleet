/**
 * The export's single pass over the legacy set.
 *
 * Streams legacy `messages` and then `archive_quarantine` in `_id` order
 * and in batches, asks the new `messages` collection which of each
 * batch's message IDs it holds with content (`_id $in`), and spools every
 * document it does not — duplicates included — together with that
 * message's legacy revisions and reaction user lists. Placement follows
 * the channel's access state in the new `archive_channels`. Finally every
 * inbox event the legacy writer had not completed is spooled as-is.
 *
 * Memory holds one batch. Related records are exported once per message
 * ID within a batch; a quarantine batch skips message IDs that legacy
 * `messages` also holds, because the messages pass already exported their
 * related records. A message ID duplicated across batches of the same
 * source exports its related records again — harmless duplicates that
 * keep memory independent of the export size.
 */
import type { mongo } from 'mongoose';

import { emptySourceCounts, type ExportedSource, type SourceCounts } from './manifest';
import { categoryForChannel, presentMessageIds, type ChannelAccess } from './new-backup';
import type { ExportRecord, RecordPlacement, RecordSpool } from './spool';

/** Legacy collection names by source; `null` when that collection is absent from the legacy set. */
export type LegacySources = Readonly<Record<ExportedSource, string | null>>;

export interface ScanSummary {
  /** Legacy documents examined, per scanned source. */
  readonly scanned: {
    readonly messages: number;
    readonly archive_quarantine: number;
    readonly archive_inbox: number;
  };
  /** Legacy message documents skipped because the new backup holds their message with content. */
  readonly inNewBackup: number;
  /** Exported records per source. */
  readonly exported: SourceCounts;
}

type LegacyDocument = Record<string, unknown>;
type Entry = { placement: RecordPlacement; record: ExportRecord };

interface ScanContext {
  readonly db: mongo.Db;
  readonly sources: LegacySources;
  readonly spool: RecordSpool;
  readonly batchSize: number;
  readonly access: ReadonlyMap<string, ChannelAccess>;
  readonly exported: SourceCounts;
  inNewBackup: number;
}

const SNOWFLAKE = /^\d{1,20}$/;
const INBOX_PLACEMENT: RecordPlacement = {
  category: 'inbox-pending',
  channelId: null,
  channelName: null,
};

const snowflakeOrNull = (value: unknown): string | null =>
  typeof value === 'string' && SNOWFLAKE.test(value) ? value : null;

const nameOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/** Legacy messages carry their channel at the top level; quarantine evidence nests it in `snapshot`. */
const channelFields = (source: 'messages' | 'archive_quarantine', doc: LegacyDocument) => {
  const holder =
    source === 'archive_quarantine' &&
    typeof doc['snapshot'] === 'object' &&
    doc['snapshot'] !== null
      ? (doc['snapshot'] as LegacyDocument)
      : doc;
  return {
    channelId: snowflakeOrNull(holder['channelId']),
    channelName: nameOrNull(holder['channelName']),
  };
};

const placementFor = (
  ctx: ScanContext,
  messageId: string | null,
  channelId: string | null,
  channelName: string | null,
): RecordPlacement =>
  messageId === null || channelId === null
    ? { category: 'unattributed', channelId: null, channelName: null }
    : { category: categoryForChannel(ctx.access.get(channelId)), channelId, channelName };

/** Stream `filter` from one legacy collection in `_id` order, handing over full batches. */
const forEachBatch = async (
  ctx: ScanContext,
  collection: string,
  filter: Record<string, unknown>,
  handle: (batch: LegacyDocument[]) => Promise<void>,
): Promise<number> => {
  const cursor = ctx.db
    .collection<LegacyDocument>(collection)
    // Related lookups sort their `$in` matches; allow spilling rather than hitting the sort memory cap.
    .find(filter, { allowDiskUse: true })
    .sort({ _id: 1 })
    .batchSize(ctx.batchSize);
  let seen = 0;
  let batch: LegacyDocument[] = [];
  for await (const document of cursor) {
    batch.push(document);
    seen += 1;
    if (batch.length >= ctx.batchSize) {
      await handle(batch);
      batch = [];
    }
  }
  if (batch.length > 0) await handle(batch);
  return seen;
};

/** Spool one related collection's records for `owners`, each beside its message. */
const exportRelated = async (
  ctx: ScanContext,
  source: 'archive_revisions' | 'archive_reactions',
  owners: ReadonlyMap<string, RecordPlacement>,
): Promise<void> => {
  const collection = ctx.sources[source];
  if (collection === null || owners.size === 0) return;
  await forEachBatch(ctx, collection, { messageId: { $in: [...owners.keys()] } }, async (batch) => {
    const entries: Entry[] = [];
    for (const document of batch) {
      const messageId = snowflakeOrNull(document['messageId']);
      const placement = messageId === null ? undefined : owners.get(messageId);
      if (placement === undefined) continue;
      entries.push({ placement, record: { collection: source, messageId, document } });
      ctx.exported[source] += 1;
    }
    await ctx.spool.append(entries);
  });
};

/** Message IDs among `ids` that legacy `messages` holds; their related records are already exported. */
const heldByLegacyMessages = async (
  ctx: ScanContext,
  ids: readonly string[],
): Promise<ReadonlySet<string>> => {
  const collection = ctx.sources.messages;
  if (collection === null || ids.length === 0) return new Set();
  const found = await ctx.db
    .collection<{ messageId?: unknown }>(collection)
    .find({ messageId: { $in: [...ids] } }, { projection: { _id: 0, messageId: 1 } })
    .toArray();
  return new Set(found.map((doc) => doc.messageId).filter((id) => typeof id === 'string'));
};

const processBatch = async (
  ctx: ScanContext,
  source: 'messages' | 'archive_quarantine',
  batch: readonly LegacyDocument[],
): Promise<void> => {
  const identities = batch.map((document) => ({
    document,
    messageId: snowflakeOrNull(document['messageId']),
    ...channelFields(source, document),
  }));
  const ids = [...new Set(identities.map((i) => i.messageId).filter((id) => id !== null))];
  const present = await presentMessageIds(ctx.db, ids);
  const entries: Entry[] = [];
  const owners = new Map<string, RecordPlacement>();
  for (const { document, messageId, channelId, channelName } of identities) {
    if (messageId !== null && present.has(messageId)) {
      ctx.inNewBackup += 1;
      continue;
    }
    const placement = placementFor(ctx, messageId, channelId, channelName);
    entries.push({ placement, record: { collection: source, messageId, document } });
    ctx.exported[source] += 1;
    if (messageId !== null && !owners.has(messageId)) owners.set(messageId, placement);
  }
  await ctx.spool.append(entries);
  if (source === 'archive_quarantine') {
    for (const id of await heldByLegacyMessages(ctx, [...owners.keys()])) owners.delete(id);
  }
  await exportRelated(ctx, 'archive_revisions', owners);
  await exportRelated(ctx, 'archive_reactions', owners);
};

const scanMessages = (ctx: ScanContext, source: 'messages' | 'archive_quarantine') => {
  const collection = ctx.sources[source];
  return collection === null
    ? Promise.resolve(0)
    : forEachBatch(ctx, collection, {}, (batch) => processBatch(ctx, source, batch));
};

const scanInbox = (ctx: ScanContext): Promise<number> => {
  const collection = ctx.sources.archive_inbox;
  if (collection === null) return Promise.resolve(0);
  return forEachBatch(ctx, collection, { state: { $ne: 'complete' } }, async (batch) => {
    await ctx.spool.append(
      batch.map((document) => ({
        placement: INBOX_PLACEMENT,
        record: {
          collection: 'archive_inbox',
          messageId: snowflakeOrNull(document['messageId']),
          document,
        },
      })),
    );
    ctx.exported.archive_inbox += batch.length;
  });
};

export const scanLegacySet = async (
  db: mongo.Db,
  sources: LegacySources,
  access: ReadonlyMap<string, ChannelAccess>,
  spool: RecordSpool,
  batchSize: number,
): Promise<ScanSummary> => {
  const ctx: ScanContext = {
    db,
    sources,
    spool,
    batchSize,
    access,
    exported: emptySourceCounts(),
    inNewBackup: 0,
  };
  const messages = await scanMessages(ctx, 'messages');
  const quarantine = await scanMessages(ctx, 'archive_quarantine');
  const inbox = await scanInbox(ctx);
  return {
    scanned: { messages, archive_quarantine: quarantine, archive_inbox: inbox },
    inNewBackup: ctx.inNewBackup,
    exported: ctx.exported,
  };
};
