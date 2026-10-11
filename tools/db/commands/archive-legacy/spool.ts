/**
 * Incremental writer for the per-channel export files.
 *
 * Records arrive one batch at a time from cursors over multi-gigabyte
 * collections, in no channel order, so each channel's file is appended
 * to rather than held open or built in memory: only one small state
 * entry per file stays resident. Every file is a canonical-EJSON array
 * with exactly one record per line — `[`, one record per line with a
 * trailing comma on all but the last, `]` — which keeps it valid JSON
 * while letting verification parse it line by line in bounded memory.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { mongo } from 'mongoose';

import {
  emptySourceCounts,
  type ExportCategory,
  type ExportedSource,
  type ManifestFile,
  type SourceCounts,
} from './manifest';

const { EJSON } = mongo.BSON;

/** One exported document with its provenance. */
export interface ExportRecord {
  readonly collection: ExportedSource;
  readonly messageId: string | null;
  readonly document: unknown;
}

/** Where one record goes: a channel file within its category, the unattributed file, or the inbox file. */
export interface RecordPlacement {
  readonly category: ExportCategory;
  readonly channelId: string | null;
  readonly channelName: string | null;
}

interface FileState {
  readonly path: string;
  readonly category: ExportCategory;
  readonly channelId: string | null;
  channelName: string | null;
  records: number;
  readonly counts: SourceCounts;
}

const SNOWFLAKE = /^\d{1,20}$/;
const UNATTRIBUTED_FILE = 'unattributed.json';
const INBOX_FILE = 'inbox/pending.json';
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** The archive-relative path for a placement; IDs are re-validated because they come from the database. */
export const placementPath = (placement: RecordPlacement): string => {
  if (placement.category === 'inbox-pending') return INBOX_FILE;
  return placement.category === 'unattributed' ||
    placement.channelId === null ||
    !SNOWFLAKE.test(placement.channelId)
    ? UNATTRIBUTED_FILE
    : `${placement.category}/${placement.channelId}.json`;
};

/** Canonical EJSON keeps every BSON numeric type (Int32, Int64, Double, Decimal128) distinct. */
export const serializeRecord = (record: ExportRecord): string =>
  EJSON.stringify(record, { relaxed: false });

export const sha256File = (file: string): Promise<string> =>
  new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolvePromise(hash.digest('hex')));
  });

/** Spools records into category/channel files under `root`; `null` root counts without writing. */
export class RecordSpool {
  private readonly files = new Map<string, FileState>();

  public constructor(private readonly root: string | null) {}

  /** Append a batch; records sharing a placement are written with one filesystem call. */
  public async append(entries: readonly { placement: RecordPlacement; record: ExportRecord }[]) {
    const chunks = new Map<string, string[]>();
    for (const { placement, record } of entries) {
      const relative = placementPath(placement);
      const state = this.stateFor(relative, placement);
      const line = serializeRecord(record);
      const lines = chunks.get(relative) ?? [];
      // The first record opens the array; later ones close the previous line with a comma.
      lines.push(state.records === 0 ? `[\n${line}` : `,\n${line}`);
      chunks.set(relative, lines);
      state.records += 1;
      state.counts[record.collection] += 1;
      if (state.channelId !== null) state.channelName ??= placement.channelName;
    }
    if (this.root === null) return;
    for (const [relative, lines] of chunks) {
      const file = path.join(this.root, relative);
      await mkdir(path.dirname(file), { recursive: true, mode: DIR_MODE });
      await appendFile(file, lines.join(''), { mode: FILE_MODE });
    }
  }

  /** Close every array and describe each file; a counting-only spool reports zero bytes and no hash. */
  public async finish(): Promise<ManifestFile[]> {
    const described: ManifestFile[] = [];
    for (const state of [...this.files.values()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      let bytes = 0;
      let sha256 = '0'.repeat(64);
      if (this.root !== null) {
        const file = path.join(this.root, state.path);
        await appendFile(file, '\n]\n');
        bytes = (await stat(file)).size;
        sha256 = await sha256File(file);
      }
      described.push({
        path: state.path,
        category: state.category,
        channelId: state.channelId,
        channelName: state.channelName,
        records: state.records,
        counts: { ...state.counts },
        bytes,
        sha256,
      });
    }
    return described;
  }

  private stateFor(relative: string, placement: RecordPlacement): FileState {
    const existing = this.files.get(relative);
    if (existing !== undefined) return existing;
    const unattributed = relative === UNATTRIBUTED_FILE;
    const perChannel = !unattributed && relative !== INBOX_FILE;
    const created: FileState = {
      path: relative,
      category: unattributed ? 'unattributed' : placement.category,
      channelId: perChannel ? placement.channelId : null,
      channelName: null,
      records: 0,
      counts: emptySourceCounts(),
    };
    this.files.set(relative, created);
    return created;
  }
}
