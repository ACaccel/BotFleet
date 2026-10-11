/**
 * Suite for the export verifier, the spool format it checks, and the
 * zip adapter. Uses the real `zip` / `unzip` binaries from the project
 * runtime; no database.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { mongo } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createZipTools } from '../../framework/zip-tools';

import type { ExportManifest } from './manifest';
import { placementPath, RecordSpool, serializeRecord } from './spool';
import { buildArchive, repack, sampleEntry, type BuiltArchive } from './test-support';
import { verifyExportArchive } from './verify';

const tools = createZipTools();
let work: string;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'archive-legacy-verify-'));
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

const spec = {
  guildId: '42',
  legacyTimestamp: '1700000000000',
  entries: [sampleEntry('1', '10'), sampleEntry('2', '10'), sampleEntry('3', '11')],
};
const line = (messageId: string, channelId: string): string =>
  serializeRecord(sampleEntry(messageId, channelId).record);

const build = async (name: string): Promise<BuiltArchive & { zipPath: string }> => {
  const zipPath = path.join(work, name);
  return { zipPath, ...(await buildArchive(tools, work, zipPath, spec)) };
};

/** Replace one data file and record its new size and hash, so only the structural checks can object. */
const replaceWithMatchingHash = async (
  built: BuiltArchive & { zipPath: string },
  file: string,
  body: string,
): Promise<void> => {
  await writeFile(path.join(built.stage, file), body);
  const manifest: ExportManifest = {
    ...built.manifest,
    files: built.manifest.files.map((f) =>
      f.path === file
        ? {
            ...f,
            bytes: Buffer.byteLength(body),
            sha256: createHash('sha256').update(body).digest('hex'),
          }
        : f,
    ),
  };
  await repack(tools, built.stage, built.zipPath, manifest);
};

describe('archive-legacy / spool', () => {
  it('places records by category and channel, re-validating IDs from the database', () => {
    expect(placementPath({ category: 'channel-deleted', channelId: '12', channelName: null })).toBe(
      'channel-deleted/12.json',
    );
    expect(
      placementPath({ category: 'message-missing', channelId: '../x', channelName: null }),
    ).toBe('unattributed.json');
    expect(placementPath({ category: 'message-missing', channelId: null, channelName: null })).toBe(
      'unattributed.json',
    );
    expect(placementPath({ category: 'inbox-pending', channelId: '12', channelName: null })).toBe(
      'inbox/pending.json',
    );
  });

  it('writes a valid JSON array with one canonical-EJSON record per line', async () => {
    const spool = new RecordSpool(work);
    const document = {
      _id: new mongo.ObjectId('0123456789abcdef01234567'),
      at: new Date(0),
      n: 5,
      big: mongo.Long.fromString('9007199254740993'),
    };
    await spool.append([
      {
        placement: sampleEntry('1', '10').placement,
        record: { collection: 'messages', messageId: '1', document },
      },
    ]);
    await spool.append([sampleEntry('2', '10')]);
    const [file] = await spool.finish();
    expect(file).toMatchObject({
      path: 'message-missing/10.json',
      records: 2,
      channelName: 'name-10',
    });
    expect(file?.counts.messages).toBe(2);

    const text = await readFile(path.join(work, 'message-missing/10.json'), 'utf8');
    expect(text.split('\n')).toHaveLength(5);
    expect(text).toContain('{"$numberInt":"5"}');
    const parsed = mongo.BSON.EJSON.parse(text, { relaxed: false }) as {
      document: typeof document;
    }[];
    expect(parsed[0]?.document._id).toBeInstanceOf(mongo.ObjectId);
    expect(parsed[0]?.document.at).toEqual(new Date(0));
    expect(String(parsed[0]?.document.big)).toBe('9007199254740993');
  });

  it('counts without writing when it has no root', async () => {
    const spool = new RecordSpool(null);
    await spool.append(spec.entries);
    const files = await spool.finish();
    expect(files.map((f) => [f.path, f.records])).toEqual([
      ['message-missing/10.json', 2],
      ['message-missing/11.json', 1],
    ]);
    expect(await readdir(work)).toEqual([]);
  });
});

describe('archive-legacy / verifyExportArchive', () => {
  it('passes a well-formed archive and returns its manifest', async () => {
    const built = await build('ok.zip');
    const { report, manifest } = await verifyExportArchive(built.zipPath, tools);
    expect(report.errors).toEqual([]);
    expect(report).toMatchObject({ ok: true, files: 2, records: 3 });
    expect(manifest).toEqual(built.manifest);
  });

  it('fails the integrity test on a corrupted archive', async () => {
    const zipPath = path.join(work, 'bad.zip');
    await writeFile(zipPath, 'not a zip');
    const { report } = await verifyExportArchive(zipPath, tools);
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toMatch(/integrity test failed/);
  });

  it('detects a data file whose content no longer matches its recorded hash', async () => {
    const built = await build('tampered.zip');
    await writeFile(
      path.join(built.stage, 'message-missing/11.json'),
      `[\n${line('9', '11')}\n]\n`,
    );
    await repack(tools, built.stage, built.zipPath, built.manifest);
    const { report } = await verifyExportArchive(built.zipPath, tools);
    expect(report.errors).toEqual(['message-missing/11.json: sha256 differs from the manifest']);
  });

  it.each([
    ['no opening bracket', () => `${line('3', '11')}\n]\n`, /does not open with "\["/],
    ['truncated file', () => `[\n${line('3', '11')}\n`, /does not close with "\]"/],
    [
      'missing comma',
      () => `[\n${line('3', '11')}\n${line('4', '11')}\n]\n`,
      /record is missing its comma/,
    ],
    ['trailing comma', () => `[\n${line('3', '11')},\n]\n`, /last record has a trailing comma/],
    [
      'content after the array',
      () => `[\n${line('3', '11')}\n]\nextra\n`,
      /has content after the closing "\]"/,
    ],
    ['invalid EJSON line', () => `[\n{not json}\n]\n`, /JSON/],
    [
      'unknown collection',
      () =>
        `[\n${serializeRecord({ ...sampleEntry('3', '11').record, collection: 'fetches' as 'messages' })}\n]\n`,
      /collection/,
    ],
    [
      'extra valid record',
      () => `[\n${line('3', '11')},\n${line('4', '11')}\n]\n`,
      /record counts .* differ from the manifest/,
    ],
  ])('rejects a data file with %s even when its hash matches', async (_name, body, error) => {
    const built = await build('malformed.zip');
    await replaceWithMatchingHash(built, 'message-missing/11.json', body());
    const { report } = await verifyExportArchive(built.zipPath, tools);
    expect(report.ok).toBe(false);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatch(/^message-missing\/11\.json: /);
    expect(report.errors[0]).toMatch(error);
  });

  it('rejects category totals that differ from the files', async () => {
    const built = await build('totals.zip');
    const categories = {
      ...built.manifest.categories,
      'message-missing': { ...built.manifest.categories['message-missing'], messages: 99 },
    };
    await repack(tools, built.stage, built.zipPath, { ...built.manifest, categories });
    const { report } = await verifyExportArchive(built.zipPath, tools);
    expect(report.errors).toEqual([
      'category message-missing: totals differ from the sum of its files',
    ]);
  });

  it('rejects a legacy collection entry from another legacy set', async () => {
    const built = await build('legacy.zip');
    const legacyCollections = [
      { ...built.manifest.legacyCollections[0], name: 'legacy_1_messages' },
    ];
    await repack(tools, built.stage, built.zipPath, { ...built.manifest, legacyCollections });
    const { report } = await verifyExportArchive(built.zipPath, tools);
    expect(report.errors).toEqual([
      'legacy collection legacy_1_messages: inconsistent with the manifest',
    ]);
  });

  it('rejects files missing from or not listed in the manifest', async () => {
    const built = await build('set.zip');
    await rm(path.join(built.stage, 'message-missing/11.json'));
    await mkdir(path.join(built.stage, 'channel-deleted'));
    await writeFile(path.join(built.stage, 'channel-deleted/99.json'), '[]');
    await repack(tools, built.stage, built.zipPath, built.manifest);
    const { report } = await verifyExportArchive(built.zipPath, tools);
    expect(report.errors).toEqual([
      'channel-deleted/99.json: not listed in the manifest',
      'message-missing/11.json: missing from the archive',
    ]);
  });

  it('rejects entries outside the known data paths', async () => {
    const built = await build('names.zip');
    await writeFile(path.join(built.stage, 'notes.txt'), 'x');
    await repack(tools, built.stage, built.zipPath, built.manifest);
    const { report, manifest } = await verifyExportArchive(built.zipPath, tools);
    expect(manifest).toBeNull();
    expect(report.errors).toEqual(['unexpected archive entries: notes.txt']);
  });

  it('rejects an archive without a manifest', async () => {
    const built = await build('nomanifest.zip');
    await rm(path.join(built.stage, 'manifest.json'));
    await rm(built.zipPath);
    await tools.create(built.stage, built.zipPath);
    const { report } = await verifyExportArchive(built.zipPath, tools);
    expect(report.errors).toEqual(['manifest.json: missing from the archive']);
  });

  it('rejects a manifest that is not JSON', async () => {
    const built = await build('json.zip');
    await writeFile(path.join(built.stage, 'manifest.json'), '{oops');
    await rm(built.zipPath);
    await tools.create(built.stage, built.zipPath);
    const { report, manifest } = await verifyExportArchive(built.zipPath, tools);
    expect(manifest).toBeNull();
    expect(report.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.errors[0]).toMatch(/^manifest\.json: .*JSON/);
  });

  it('rejects a manifest of another format', async () => {
    const built = await build('format.zip');
    await repack(tools, built.stage, built.zipPath, { ...built.manifest, format: 'other' });
    const { report, manifest } = await verifyExportArchive(built.zipPath, tools);
    expect(manifest).toBeNull();
    expect(report.errors[0]).toMatch(/^manifest\.json: format/);
  });

  it('rejects a manifest file path that escapes the archive', async () => {
    const built = await build('traversal.zip');
    const files = built.manifest.files.map((f, i) => (i === 0 ? { ...f, path: '../x.json' } : f));
    await repack(tools, built.stage, built.zipPath, { ...built.manifest, files });
    const { report, manifest } = await verifyExportArchive(built.zipPath, tools);
    expect(manifest).toBeNull();
    expect(report.errors[0]).toMatch(/^manifest\.json: files\.0\.path/);
  });
});

describe('archive-legacy / zip tools', () => {
  it('fails fast when a binary is missing', async () => {
    const missing = createZipTools({ zip: 'botfleet-no-such-zip', unzip: 'unzip' });
    await expect(missing.assertAvailable()).rejects.toThrow(/"botfleet-no-such-zip" was not found/);
  });

  it('finds both project binaries', async () => {
    await expect(tools.assertAvailable()).resolves.toBeUndefined();
  });

  it('lists entries and streams one without extracting', async () => {
    const built = await build('stream.zip');
    expect((await tools.list(built.zipPath)).sort()).toEqual([
      'manifest.json',
      'message-missing/10.json',
      'message-missing/11.json',
    ]);
    const text = await tools.readEntry(built.zipPath, 'message-missing/11.json', async (input) => {
      let out = '';
      for await (const chunk of input) out += String(chunk);
      return out;
    });
    expect(text).toBe(`[\n${line('3', '11')}\n]\n`);
    expect((await readdir(work)).sort()).toEqual(['stage-stream.zip', 'stream.zip']);
  });

  it('ends the child when a consumer stops early', async () => {
    const built = await build('early.zip');
    await expect(
      tools.readEntry(built.zipPath, 'message-missing/10.json', () =>
        Promise.reject(new Error('consumer gave up')),
      ),
    ).rejects.toThrow('consumer gave up');
  });

  it('kills a run that exceeds its timeout and reports the signal', async () => {
    // A stand-in unzip that never finishes, whatever its arguments.
    const hanging = path.join(work, 'hanging-unzip');
    await writeFile(hanging, '#!/bin/sh\nexec sleep 30\n', { mode: 0o700 });
    const endless = createZipTools({ zip: 'zip', unzip: hanging, timeoutMs: 200 });
    await expect(endless.test(path.join(work, 'any.zip'))).rejects.toThrow(
      /signal SIGKILL; the timeout is 200 ms/,
    );
  });
});
