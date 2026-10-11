/**
 * Independent verification of a legacy-archive export.
 *
 * Trusts nothing but the archive itself: runs `unzip -t`, requires every
 * entry name to be a known data path or the manifest, validates
 * `manifest.json`, requires the entry set to equal the manifest's, then
 * streams every data file straight out of the archive (`unzip -p`) —
 * checking the array framing, parsing each record as canonical EJSON,
 * and recomputing record counts, byte size, and sha256 — and finally
 * cross-checks the per-category totals and the legacy collection list.
 * Nothing is extracted to disk, so archive entries can never become
 * symlinks, devices, or a disk-space peak. Export runs this before it
 * publishes an archive; drop runs it before deleting any legacy data.
 */
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

import { mongo } from 'mongoose';
import { z } from 'zod';

import type { ZipTools } from '../../framework/zip-tools';

import { parseLegacyCollectionName } from './collections';
import {
  DATA_FILE_PATH,
  emptySourceCounts,
  EXPORT_CATEGORIES,
  EXPORTED_SOURCES,
  MANIFEST_FILE,
  manifestSchema,
  type ExportManifest,
  type ManifestFile,
  type SourceCounts,
} from './manifest';

const { EJSON } = mongo.BSON;

export interface VerificationReport {
  readonly ok: boolean;
  readonly zipPath: string;
  readonly manifestSha256: string | null;
  readonly files: number;
  readonly records: number;
  readonly errors: readonly string[];
}

export interface VerificationResult {
  readonly report: VerificationReport;
  /** The parsed manifest; `null` when the archive or its manifest is unusable. */
  readonly manifest: ExportManifest | null;
}

/** A manifest lists at most one entry per channel; this bounds a hostile archive's memory use. */
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

const recordSchema = z.object({
  collection: z.enum(EXPORTED_SOURCES),
  messageId: z.string().nullable(),
  document: z.unknown(),
});

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const readSmall = async (input: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_MANIFEST_BYTES) throw new Error('is larger than the manifest limit');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
};

const parseRecordLine = (line: string, isLast: boolean): z.infer<typeof recordSchema> => {
  if (isLast === line.endsWith(',')) {
    throw new Error(isLast ? 'last record has a trailing comma' : 'record is missing its comma');
  }
  const parsed: unknown = EJSON.parse(isLast ? line : line.slice(0, -1), { relaxed: false });
  return recordSchema.parse(parsed);
};

interface StreamFacts {
  readonly counts: SourceCounts;
  readonly bytes: number;
  readonly sha256: string;
}

/** Hash, size, and parse one data file in a single pass, throwing on the first defect. */
const inspectStream = async (input: Readable): Promise<StreamFacts> => {
  const hash = createHash('sha256');
  let bytes = 0;
  // Attached in the same tick as the line reader, so both observe every chunk.
  input.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    bytes += chunk.length;
  });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const counts = emptySourceCounts();
  let first = true;
  let previous: string | null = null;
  for await (const line of lines) {
    if (first) {
      if (line !== '[') throw new Error('does not open with "["');
      first = false;
      continue;
    }
    if (previous === ']') throw new Error('has content after the closing "]"');
    if (previous !== null) counts[parseRecordLine(previous, line === ']').collection] += 1;
    previous = line;
  }
  if (previous !== ']') throw new Error('does not close with "]"');
  return { counts, bytes, sha256: hash.digest('hex') };
};

const sameCounts = (a: SourceCounts, b: SourceCounts): boolean =>
  EXPORTED_SOURCES.every((source) => a[source] === b[source]);

const verifyFile = async (
  tools: ZipTools,
  zipPath: string,
  entry: ManifestFile,
): Promise<string | null> => {
  try {
    const facts = await tools.readEntry(zipPath, entry.path, inspectStream);
    const records = EXPORTED_SOURCES.reduce((sum, source) => sum + facts.counts[source], 0);
    if (records !== entry.records || !sameCounts(facts.counts, entry.counts)) {
      return `${entry.path}: record counts ${JSON.stringify(facts.counts)} differ from the manifest`;
    }
    if (facts.bytes !== entry.bytes) return `${entry.path}: byte size differs from the manifest`;
    if (facts.sha256 !== entry.sha256) return `${entry.path}: sha256 differs from the manifest`;
    return null;
  } catch (error: unknown) {
    return `${entry.path}: ${describe(error)}`;
  }
};

/** Manifest-internal consistency: category totals and the legacy collection list. */
const manifestErrors = (manifest: ExportManifest): string[] => {
  const errors: string[] = [];
  for (const category of EXPORT_CATEGORIES) {
    const sum = emptySourceCounts();
    for (const file of manifest.files.filter((f) => f.category === category)) {
      for (const source of EXPORTED_SOURCES) sum[source] += file.counts[source];
    }
    if (!sameCounts(sum, manifest.categories[category] ?? emptySourceCounts())) {
      errors.push(`category ${category}: totals differ from the sum of its files`);
    }
  }
  const names = new Set<string>();
  for (const collection of manifest.legacyCollections) {
    const parsed = parseLegacyCollectionName(collection.name);
    if (
      parsed?.timestamp !== manifest.legacyTimestamp ||
      parsed.source !== collection.source ||
      names.has(collection.name)
    ) {
      errors.push(`legacy collection ${collection.name}: inconsistent with the manifest`);
    }
    names.add(collection.name);
  }
  return errors;
};

const verifyEntries = async (
  tools: ZipTools,
  zipPath: string,
): Promise<Omit<VerificationReport, 'ok' | 'zipPath'> & { manifest: ExportManifest | null }> => {
  const unusable = (manifestSha256: string | null, error: string) => ({
    manifest: null,
    manifestSha256,
    files: 0,
    records: 0,
    errors: [error],
  });
  const names = await tools.list(zipPath);
  const invalid = names.filter((name) => name !== MANIFEST_FILE && !DATA_FILE_PATH.test(name));
  if (invalid.length > 0) {
    return unusable(null, `unexpected archive entries: ${invalid.join(', ')}`);
  }
  if (new Set(names).size !== names.length) return unusable(null, 'duplicate archive entries');
  if (!names.includes(MANIFEST_FILE))
    return unusable(null, `${MANIFEST_FILE}: missing from the archive`);

  const bytes = await tools.readEntry(zipPath, MANIFEST_FILE, readSmall);
  const manifestSha256 = createHash('sha256').update(bytes).digest('hex');
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error: unknown) {
    return unusable(manifestSha256, `${MANIFEST_FILE}: ${describe(error)}`);
  }
  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const reason = issue === undefined ? 'invalid' : `${issue.path.join('.')}: ${issue.message}`;
    return unusable(manifestSha256, `${MANIFEST_FILE}: ${reason}`);
  }
  const manifest = result.data;
  const expected = new Set([MANIFEST_FILE, ...manifest.files.map((f) => f.path)]);
  const actual = new Set(names);
  const errors = [
    ...[...actual].filter((f) => !expected.has(f)).map((f) => `${f}: not listed in the manifest`),
    ...[...expected].filter((f) => !actual.has(f)).map((f) => `${f}: missing from the archive`),
  ];
  for (const entry of manifest.files.filter((f) => actual.has(f.path))) {
    const error = await verifyFile(tools, zipPath, entry);
    if (error !== null) errors.push(error);
  }
  errors.push(...manifestErrors(manifest));
  return {
    manifest,
    manifestSha256,
    files: manifest.files.length,
    records: manifest.files.reduce((sum, f) => sum + f.records, 0),
    errors,
  };
};

/** Verify `zipPath` from the archive alone. */
export const verifyExportArchive = async (
  zipPath: string,
  tools: ZipTools,
): Promise<VerificationResult> => {
  const failed = (error: string): VerificationResult => ({
    manifest: null,
    report: { ok: false, zipPath, manifestSha256: null, files: 0, records: 0, errors: [error] },
  });
  try {
    await tools.test(zipPath);
  } catch (error: unknown) {
    return failed(`integrity test failed: ${describe(error)}`);
  }
  try {
    const { manifest, ...rest } = await verifyEntries(tools, zipPath);
    return { manifest, report: { ok: rest.errors.length === 0, zipPath, ...rest } };
  } catch (error: unknown) {
    return failed(`reading the archive failed: ${describe(error)}`);
  }
};
