import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { mongo, type Connection } from 'mongoose';

import type {
  RepairDependencies,
  RepairEnrichmentBatchMetric,
  RepairDocument,
  RepairMutation,
  RepairRequest,
  RepairResult,
} from './contracts';
import { ArchiveRepairCancellation, ArchiveRepairCancelledError } from './cancellation';
import { ArchiveRepairPlanningJournal } from './planning-journal';
import { ARCHIVE_LIMITS } from '../../../core/archive/limits';
import { cloneRepairDocument as clone, repairHash } from './images';
import { applyRepairBatch, readRepairTargets } from './apply-batch';

export const REPAIR_RUNS = 'archive_repair_runs';
export const REPAIR_OPERATIONS = 'archive_repair_operations';
const MESSAGES = 'messages';
const MAX_DUPLICATES = 1000;
const RETENTION_MS = 72 * 60 * 60 * 1000;
const MANIFEST_VALID_MS = 24 * 60 * 60 * 1000;

export interface RepairRun extends RepairDocument {
  _id: string;
  guildId: string;
  policyHash: string;
  schemaHash: string;
  cutoff: number;
  timestampsOnly?: boolean;
  createdAt: number;
  validUntil: number;
  status: string;
  operations: number;
  unresolved: number;
  journalBytes: number;
  journalVersion?: 1 | 2;
  sequenceHighWatermark?: number;
  acceptedAt?: number;
  expiresAt?: number;
  issues: string[];
  coverage?: RepairResult;
}

export interface RepairOperation extends RepairDocument {
  _id: string;
  runId: string;
  sequence: number;
  collection: string;
  documentId: unknown;
  before: RepairDocument | null;
  after: RepairDocument | null;
  beforeHash: string;
  afterHash: string;
  state: 'planned' | 'journaled' | 'verified' | 'rolled-back' | 'conflict';
  reason: string;
  dependencies: string[];
}

const rescueTimestamp = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
};

const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{1,20}$/.test(value);

const partialTombstone = (document: RepairDocument): boolean => {
  const deletion = document['deletion'];
  return (
    document['schemaVersion'] === 2 &&
    document['timestamp'] === undefined &&
    typeof deletion === 'object' &&
    deletion !== null &&
    'deletedAt' in deletion &&
    typeof deletion.deletedAt === 'number'
  );
};

const stableFields = ['channelId', 'userId', 'timestamp'] as const;
const uncertainFields = ['content', 'attachments', 'stickers', 'embeds', 'reactions'] as const;

/** Ambiguous snapshots remain intact instead of manufacturing an edit order or current reactions. */
const mergeCompatibleDuplicates = (
  documents: readonly RepairDocument[],
): { canonical: RepairDocument | null; conflict: string | null } => {
  if (documents.length === 0) return { canonical: null, conflict: 'empty duplicate group' };
  const scored = [...documents].sort((left, right) => {
    const score = (doc: RepairDocument): number =>
      (typeof doc['sourceVersion'] === 'number' ? 100 : 0) + Object.keys(doc).length;
    return score(right) - score(left) || String(left._id).localeCompare(String(right._id));
  });
  const first = scored[0];
  if (first === undefined) return { canonical: null, conflict: 'empty duplicate group' };
  const canonical = clone(first);
  for (const document of scored.slice(1)) {
    for (const field of [...stableFields, ...uncertainFields]) {
      const previous = canonical[field];
      const current = document[field];
      if (previous !== undefined && current !== undefined) {
        if (repairHash({ value: previous }) !== repairHash({ value: current })) {
          return { canonical: null, conflict: `conflicting ${field}` };
        }
      }
    }
    for (const [field, value] of Object.entries(document)) {
      if (field !== '_id' && canonical[field] === undefined) canonical[field] = value;
    }
  }
  return { canonical, conflict: null };
};

export class ArchiveRepairService {
  private readonly now: () => number;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly planningJournals = new Map<string, ArchiveRepairPlanningJournal>();

  constructor(
    private readonly connection: Connection,
    private readonly dependencies: RepairDependencies,
  ) {
    this.now = dependencies.now ?? Date.now;
  }

  private db(): NonNullable<Connection['db']> {
    if (this.connection.db === undefined) throw new Error('Repair requires an open guild database');
    return this.connection.db;
  }

  async execute(request: RepairRequest): Promise<RepairResult> {
    const cancellation = new ArchiveRepairCancellation(
      request.jobId,
      this.dependencies.isCancelled,
      this.dependencies.signal,
    );
    try {
      return await this.executeRequest(request, cancellation);
    } catch (error) {
      if (!(error instanceof ArchiveRepairCancelledError)) throw error;
      return {
        status: 'cancelled',
        ...(request.runId === undefined ? {} : { runId: request.runId }),
        counts: {},
        issues: [error.message],
      };
    }
  }

  private async executeRequest(
    request: RepairRequest,
    cancellation: ArchiveRepairCancellation,
  ): Promise<RepairResult> {
    await cancellation.checkpoint();
    await this.dependencies.assertOwner();
    await cancellation.checkpoint();
    if (request.command === 'audit') return this.audit(cancellation);
    if (request.command === 'migrate-timestamp') {
      const mode = request.options['mode'];
      if (mode === 'audit') return this.audit(cancellation);
      if (mode === 'index') {
        return this.dependencies.withMaintenance(async () => {
          await this.dependencies.ensureCapacity(0);
          await cancellation.checkpoint();
          await this.createIndexes(cancellation);
          return this.audit(cancellation);
        });
      }
      // Legacy convert is now an explicit inspectable manifest, never an unconditional mutation.
      return this.plan(request, true, cancellation);
    }
    if (request.command === 'plan') return this.plan(request, false, cancellation);
    if (request.command === 'backfill') {
      const planned = await this.plan(request, false, cancellation);
      if (planned.runId === undefined || planned.status !== 'complete') return planned;
      // Backfill creates a plan; operator review authorizes subsequent structural changes.
      return { ...planned, details: { action: 'Review manifest, then submit apply with run_id' } };
    }
    if (request.runId === undefined) throw new Error(`${request.command} requires run_id`);
    const run = await this.requireRun(request.runId, request.guildId);
    await cancellation.checkpoint();
    switch (request.command) {
      case 'apply':
      case 'resume':
        return this.dependencies.withMaintenance(() => this.apply(run, request, cancellation));
      case 'verify':
        return this.verify(run, cancellation);
      case 'rollback':
        return this.dependencies.withMaintenance(() => this.rollback(run, cancellation));
      case 'accept':
        return this.accept(run, cancellation);
    }
  }

  private async audit(
    cancellation: ArchiveRepairCancellation,
    progressPhase: 'repair' | 'verification' = 'repair',
    stream = 'audit',
  ): Promise<RepairResult> {
    const collection = this.db().collection<RepairDocument>(MESSAGES);
    const estimatedTotal = await collection.estimatedDocumentCount();
    await cancellation.checkpoint();
    await this.dependencies.onProgress?.(progressPhase, 0, estimatedTotal, stream, {
      quality: 'estimated',
      unit: 'documents',
      substep: 'check-messages',
    });
    let total = 0;
    let convertible = 0;
    let invalid = 0;
    let unknownAuthors = 0;
    let excluded = 0;
    const cursor = collection.find({}).batchSize(ARCHIVE_LIMITS.batchDocuments);
    try {
      for await (const document of cursor) {
        await cancellation.checkpoint();
        total += 1;
        if (
          typeof document['timestamp'] === 'string' &&
          rescueTimestamp(document['timestamp']) !== null
        ) {
          convertible += 1;
        }
        if (
          !validId(document['messageId']) ||
          (rescueTimestamp(document['timestamp']) === null && !partialTombstone(document))
        )
          invalid += 1;
        const classification = this.dependencies.classify(document);
        if (classification === 'unknown') unknownAuthors += 1;
        if (classification === 'excluded') excluded += 1;
        if (total % ARCHIVE_LIMITS.batchDocuments === 0)
          await this.dependencies.onProgress?.(
            progressPhase,
            total,
            Math.max(total, estimatedTotal),
            stream,
            {
              quality: 'estimated',
              unit: 'documents',
              substep: 'check-messages',
            },
          );
      }
    } finally {
      await cursor.close();
    }
    await cancellation.checkpoint();
    await this.dependencies.onProgress?.(progressPhase, total, total, stream, {
      quality: 'exact',
      unit: 'documents',
      substep: 'check-messages',
    });
    await this.dependencies.onProgress?.(progressPhase, total, undefined, stream, {
      quality: 'unknown',
      unit: 'checks',
      substep: 'check-duplicate-identities',
    });
    const duplicates = await collection
      .aggregate<{
        count: number;
      }>(
        [
          { $group: { _id: '$messageId', count: { $sum: 1 } } },
          { $match: { count: { $gt: 1 } } },
          { $count: 'count' },
        ],
        { allowDiskUse: true },
      )
      .next();
    await cancellation.checkpoint();
    const indexes = await collection
      .listIndexes()
      .toArray()
      .catch((error: unknown) => {
        if (error instanceof mongo.MongoServerError && error.code === 26) return [];
        throw error;
      });
    await cancellation.checkpoint();
    const uniqueIndex = indexes.some(
      (index) =>
        index.unique === true &&
        index.key?.['messageId'] === 1 &&
        Object.keys(index.key).length === 1 &&
        index.sparse !== true &&
        index.partialFilterExpression === undefined,
    );
    const fetches = this.db().collection<RepairDocument>('fetches');
    await this.dependencies.onProgress?.(progressPhase, total, undefined, stream, {
      quality: 'unknown',
      unit: 'checks',
      substep: 'check-legacy-cursors',
    });
    let invalidCursors = 0;
    const cursorAudit = fetches
      .find({}, { projection: { channelID: 1, lastMessageID: 1 } })
      .batchSize(ARCHIVE_LIMITS.batchDocuments);
    try {
      for await (const cursor of cursorAudit) {
        await cancellation.checkpoint();
        if (
          !validId(cursor['channelID']) ||
          (cursor['lastMessageID'] !== undefined &&
            cursor['lastMessageID'] !== '' &&
            !validId(cursor['lastMessageID']))
        )
          invalidCursors += 1;
      }
    } finally {
      await cursorAudit.close();
    }
    await cancellation.checkpoint();
    const duplicateCursors = await fetches
      .aggregate<{
        count: number;
      }>(
        [
          { $group: { _id: '$channelID', count: { $sum: 1 } } },
          { $match: { count: { $gt: 1 } } },
          { $count: 'count' },
        ],
        { allowDiskUse: true },
      )
      .next();
    await cancellation.checkpoint();
    return {
      status: 'complete',
      counts: {
        total,
        convertible,
        invalid,
        unknownAuthors,
        excluded,
        invalidCursors,
        duplicateCursors: duplicateCursors?.count ?? 0,
        duplicateGroups: duplicates?.count ?? 0,
      },
      issues: [],
      details: { uniqueIndex, indexes: indexes.map((index) => index.name) },
    };
  }

  private async requireRun(runId: string, guildId: string): Promise<RepairRun> {
    const run = await this.db()
      .collection<RepairRun>(REPAIR_RUNS)
      .findOne({ _id: runId, deleteRequestedAt: { $exists: false } });
    if (run === null || run.guildId !== guildId)
      throw new Error('Unknown repair run for this guild');
    if (run.journalVersion !== undefined && run.journalVersion !== 1 && run.journalVersion !== 2)
      throw new Error('Unsupported repair journal version; use a compatible archive runtime');
    if (
      run.policyHash !== this.dependencies.policyHash ||
      run.schemaHash !==
        (run.journalVersion === 2
          ? `${this.dependencies.schemaHash}:journal-v2`
          : this.dependencies.schemaHash)
    ) {
      throw new Error('Repair settings changed; produce a new manifest');
    }
    return run;
  }

  private async plan(
    request: RepairRequest,
    timestampsOnly: boolean,
    cancellation: ArchiveRepairCancellation,
  ): Promise<RepairResult> {
    const runId = randomUUID();
    const run: RepairRun = {
      _id: runId,
      originatingJobId: request.jobId,
      guildId: request.guildId,
      policyHash: this.dependencies.policyHash,
      schemaHash: `${this.dependencies.schemaHash}:journal-v2`,
      cutoff: this.now(),
      timestampsOnly,
      createdAt: this.now(),
      validUntil: this.now() + MANIFEST_VALID_MS,
      status: 'planning',
      operations: 0,
      unresolved: 0,
      journalBytes: 0,
      journalVersion: 2,
      issues: [],
    };
    await this.ensureRepairIndexes(cancellation);
    await cancellation.checkpoint();
    await this.db().collection<RepairRun>(REPAIR_RUNS).insertOne(run);
    this.planningJournals.set(
      runId,
      new ArchiveRepairPlanningJournal(this.db(), run, this.dependencies, cancellation),
    );
    const estimatedTotal = await this.db().collection(MESSAGES).estimatedDocumentCount();
    let scanned = 0;
    const candidates = { timestamps: 0, duplicates: 0, excluded: 0 };
    await this.dependencies.onProgress?.('repair', 0, estimatedTotal, 'plan', {
      quality: 'estimated',
      unit: 'documents',
      substep: 'check-messages',
      candidates: { ...candidates },
    });
    let excludedDocuments: RepairDocument[] = [];
    let excludedBytes = 0;
    const flushExcluded = async (): Promise<void> => {
      if (excludedDocuments.length === 0) return;
      await this.planRelatedDeletions(cancellation, run, excludedDocuments);
      excludedDocuments = [];
      excludedBytes = 0;
    };
    const stageExcluded = async (document: RepairDocument): Promise<void> => {
      const bytes = mongo.BSON.calculateObjectSize(document);
      if (
        excludedDocuments.length > 0 &&
        (excludedDocuments.length >= ARCHIVE_LIMITS.batchDocuments ||
          excludedBytes + bytes > ARCHIVE_LIMITS.batchBytes)
      )
        await flushExcluded();
      excludedDocuments.push(document);
      excludedBytes += bytes;
      if (
        excludedDocuments.length >= ARCHIVE_LIMITS.batchDocuments ||
        excludedBytes >= ARCHIVE_LIMITS.batchBytes
      )
        await flushExcluded();
    };
    let group: RepairDocument[] = [];
    let groupBytes = 0;
    let groupId: unknown;
    let overflow = false;
    let hasGroup = false;
    const addIssue = (issue: string): void => {
      run.unresolved += 1;
      // The manifest remains bounded; per-operation records carry exact affected IDs.
      if (run.issues.length < 100) run.issues.push(issue);
    };
    const flush = async (): Promise<void> => {
      if (group.length === 0) return;
      if (overflow) return;
      if (group.length > 1) candidates.duplicates += 1;
      const normalized: RepairDocument[] = [];
      for (const document of group) {
        const timestamp = rescueTimestamp(document['timestamp']);
        if (
          (timestamp === null && !partialTombstone(document)) ||
          !validId(document['messageId'])
        ) {
          addIssue(
            `Irreparable identity/timestamp for ${String(document._id)}; quarantined with recovery image`,
          );
          continue;
        }
        const needsNormalization = timestamp !== null && document['timestamp'] !== timestamp;
        const next = needsNormalization ? clone(document) : document;
        if (needsNormalization) next['timestamp'] = timestamp;
        normalized.push(next);
      }
      if (normalized.length !== group.length) {
        for (const document of group)
          await this.planQuarantine(cancellation, run, document, 'invalid-identity-or-timestamp');
        return;
      }
      if (timestampsOnly || group.length === 1) {
        for (let index = 0; index < group.length; index += 1) {
          const before = group[index];
          const after = normalized[index];
          if (before === undefined || after === undefined) continue;
          if (!timestampsOnly && this.dependencies.classify(after) === 'excluded') {
            candidates.excluded += 1;
            await stageExcluded(before);
          } else if (before['timestamp'] !== after['timestamp']) {
            candidates.timestamps += 1;
            await this.addOperation(
              cancellation,
              run,
              MESSAGES,
              before,
              after,
              'rescue-timestamp',
              [],
            );
          }
        }
        return;
      }
      const merged = mergeCompatibleDuplicates(normalized);
      if (merged.canonical === null) {
        addIssue(
          `Duplicate ${String(groupId)}: ${merged.conflict ?? 'unknown conflict'}; quarantined until source reconciliation`,
        );
        for (const document of group)
          await this.planQuarantine(
            cancellation,
            run,
            document,
            merged.conflict ?? 'unknown-duplicate-conflict',
          );
        return;
      }
      const canonical = merged.canonical;
      const before = group.find((document) => String(document._id) === String(canonical._id));
      if (before === undefined) throw new Error('Missing canonical before-image');
      if (this.dependencies.classify(canonical) === 'excluded') {
        candidates.excluded += group.length;
        for (const document of group) await stageExcluded(document);
        return;
      }
      const dependencies: string[] = [];
      if (repairHash(before) !== repairHash(canonical)) {
        dependencies.push(
          await this.addOperation(
            cancellation,
            run,
            MESSAGES,
            before,
            canonical,
            'merge-compatible-duplicate',
            [],
          ),
        );
      }
      for (const document of group) {
        if (String(document._id) !== String(canonical._id)) {
          await this.addOperation(
            cancellation,
            run,
            MESSAGES,
            document,
            null,
            'delete-verified-duplicate',
            dependencies,
          );
        }
      }
    };
    const cursor = this.db()
      .collection<RepairDocument>(MESSAGES)
      .find({}, { sort: { messageId: 1, _id: 1 }, allowDiskUse: true })
      .batchSize(ARCHIVE_LIMITS.batchDocuments);
    try {
      for await (const document of cursor) {
        await cancellation.checkpoint();
        scanned += 1;
        if (scanned % 100 === 0)
          await this.dependencies.onProgress?.(
            'repair',
            scanned,
            Math.max(estimatedTotal, scanned),
            'plan',
            {
              quality: 'estimated',
              unit: 'documents',
              substep: 'check-messages',
              candidates: { ...candidates },
            },
          );
        if (hasGroup && document['messageId'] !== groupId) {
          await flush();
          group = [];
          groupBytes = 0;
          overflow = false;
        }
        groupId = document['messageId'];
        hasGroup = true;
        const documentBytes = mongo.BSON.calculateObjectSize(document);
        if (
          !overflow &&
          (group.length === MAX_DUPLICATES ||
            (group.length > 0 && groupBytes + documentBytes > ARCHIVE_LIMITS.batchBytes))
        ) {
          addIssue(`Large duplicate group ${String(groupId)} streamed into recoverable quarantine`);
          for (const previous of group)
            await this.planQuarantine(cancellation, run, previous, 'large-duplicate-group');
          group = [];
          groupBytes = 0;
          overflow = true;
        }
        if (overflow)
          await this.planQuarantine(cancellation, run, document, 'large-duplicate-group');
        else {
          group.push(document);
          groupBytes += documentBytes;
        }
      }
      await flush();
      await flushExcluded();
      await this.dependencies.onProgress?.('repair', scanned, scanned, 'plan', {
        quality: 'exact',
        unit: 'documents',
        substep: 'check-messages',
        candidates: { ...candidates },
      });
      await this.dependencies.onProgress?.('repair', scanned, undefined, 'plan', {
        quality: 'unknown',
        unit: 'checks',
        substep: 'plan-legacy-cursors',
        candidates: { ...candidates },
      });
      if (!timestampsOnly) await this.planCursors(run, cancellation);
      await this.planningJournals.get(runId)?.flush();
      await this.dependencies.onProgress?.('repair', scanned, scanned, 'plan', {
        quality: 'exact',
        unit: 'documents',
        substep: 'validate-manifest',
        candidates: { ...candidates },
      });
      run.status = run.unresolved > 0 ? 'partial-plan' : 'planned';
      await this.dependencies.ensureCapacity(run.journalBytes);
      await cancellation.checkpoint();
    } catch (error: unknown) {
      run.status = 'failed-plan';
      run.issues.push(error instanceof Error ? error.message : String(error));
    } finally {
      this.planningJournals.delete(runId);
      await cursor.close();
      await this.db().collection<RepairRun>(REPAIR_RUNS).replaceOne({ _id: runId }, run);
    }
    return {
      status: cancellation.isCancelled()
        ? 'cancelled'
        : run.status === 'planned'
          ? 'complete'
          : 'partial',
      runId,
      counts: {
        operations: run.operations,
        unresolved: run.unresolved,
        journalBytes: run.journalBytes,
      },
      issues: run.issues,
      details: {
        validUntil: run.validUntil,
        cutoff: run.cutoff,
        policyHash: run.policyHash,
        schemaHash: run.schemaHash,
      },
    };
  }

  private async planCursors(
    run: RepairRun,
    cancellation: ArchiveRepairCancellation,
  ): Promise<void> {
    const cursor = this.db()
      .collection<RepairDocument>('fetches')
      .find({}, { sort: { channelID: 1, _id: 1 }, allowDiskUse: true })
      .batchSize(ARCHIVE_LIMITS.batchDocuments);
    let channelId: unknown;
    let previousOperation: string | undefined;
    let hasChannel = false;
    try {
      for await (const before of cursor) {
        await cancellation.checkpoint();
        if (!validId(before['channelID'])) {
          run.unresolved += 1;
          const evidence: RepairDocument = {
            _id: randomUUID(),
            runId: run._id,
            sourceCollection: 'fetches',
            sourceId: before._id,
            reason: 'invalid-channel-cursor',
            snapshot: clone(before),
            createdAt: this.now(),
          };
          const dependency = await this.addOperation(
            cancellation,
            run,
            'archive_quarantine',
            null,
            evidence,
            'preserve-quarantine-evidence',
            [],
          );
          await this.addOperation(
            cancellation,
            run,
            'fetches',
            before,
            null,
            'quarantine-invalid-cursor',
            [dependency],
          );
          continue;
        }
        if (hasChannel && channelId === before['channelID']) {
          previousOperation = await this.addOperation(
            cancellation,
            run,
            'fetches',
            before,
            null,
            'delete-duplicate-cursor',
            previousOperation ? [previousOperation] : [],
          );
          continue;
        }
        hasChannel = true;
        channelId = before['channelID'];
        previousOperation = undefined;
        if (before['lastMessageID'] !== '') {
          const after = { ...before, lastMessageID: '' };
          previousOperation = await this.addOperation(
            cancellation,
            run,
            'fetches',
            before,
            after,
            'reset-cursor-for-full-reconciliation',
            [],
          );
        }
      }
    } finally {
      await cursor.close();
    }
  }

  private async planQuarantine(
    cancellation: ArchiveRepairCancellation,
    run: RepairRun,
    document: RepairDocument,
    reason: string,
  ): Promise<void> {
    const evidence: RepairDocument = {
      _id: randomUUID(),
      runId: run._id,
      messageId: document['messageId'],
      sourceId: document._id,
      reason,
      snapshot: clone(document),
      createdAt: this.now(),
    };
    const dependency = await this.addOperation(
      cancellation,
      run,
      'archive_quarantine',
      null,
      evidence,
      'preserve-quarantine-evidence',
      [],
    );
    await this.addOperation(cancellation, run, MESSAGES, document, null, 'relocate-to-quarantine', [
      dependency,
    ]);
  }

  private async planRelatedDeletions(
    cancellation: ArchiveRepairCancellation,
    run: RepairRun,
    documents: readonly RepairDocument[],
  ): Promise<void> {
    const identities = [...new Set(documents.map((document) => document['messageId']))];
    const dependencies = new Map<unknown, string>();
    // Stream related records; only one dependency ID per source identity remains in memory.
    for (const collection of ['archive_revisions', 'archive_reactions']) {
      await cancellation.checkpoint();
      const cursor = this.db()
        .collection<RepairDocument>(collection)
        .find({ messageId: { $in: identities } })
        .batchSize(ARCHIVE_LIMITS.batchDocuments);
      try {
        for await (const relation of cursor) {
          const identity = relation['messageId'];
          const dependency = dependencies.get(identity);
          const previous = await this.addOperation(
            cancellation,
            run,
            collection,
            relation,
            null,
            'policy-excluded-related-record',
            dependency === undefined ? [] : [dependency],
          );
          dependencies.set(identity, previous);
        }
      } finally {
        await cursor.close();
      }
    }
    for (const document of documents) {
      const dependency = dependencies.get(document['messageId']);
      await this.addOperation(
        cancellation,
        run,
        MESSAGES,
        document,
        null,
        'policy-excluded-source',
        dependency === undefined ? [] : [dependency],
      );
    }
  }

  private async addOperation(
    cancellation: ArchiveRepairCancellation,
    run: RepairRun,
    collection: string,
    before: RepairDocument | null,
    after: RepairDocument | null,
    reason: string,
    dependencies: string[],
  ): Promise<string> {
    await cancellation.checkpoint();
    const beforeHash = repairHash(before);
    const afterHash = repairHash(after);
    const operation: RepairOperation = {
      _id: `${run._id}:${repairHash({ collection, documentId: (before ?? after)?._id, beforeHash, afterHash, reason })}`,
      runId: run._id,
      sequence: run.operations,
      collection,
      documentId: (before ?? after)?._id,
      before,
      after,
      beforeHash,
      afterHash,
      state: 'planned',
      reason,
      dependencies,
    };
    const journal = this.planningJournals.get(run._id);
    if (journal !== undefined) return journal.stage(operation);
    if (run.journalVersion === 2)
      throw new Error('Repair journal sequencing authority is unavailable');
    // Legacy runs keep their existing per-operation sequencing and persistence protocol.
    const operations = this.db().collection<RepairOperation>(REPAIR_OPERATIONS);
    const existing = await operations.findOne({ _id: operation._id });
    if (existing !== null) {
      run.operations = Math.max(run.operations, existing.sequence + 1);
      return existing._id;
    }
    const latest = await operations.find({ runId: run._id }).sort({ sequence: -1 }).limit(1).next();
    operation.sequence = Math.max(run.operations, (latest?.sequence ?? -1) + 1);
    const bytes = mongo.BSON.calculateObjectSize(operation);
    const insert = async (): Promise<void> => {
      await cancellation.checkpoint();
      await operations.insertOne(operation);
    };
    if (this.dependencies.withCapacity !== undefined)
      await this.dependencies.withCapacity(bytes, insert);
    else {
      await this.dependencies.ensureCapacity(bytes);
      await insert();
    }
    run.operations = operation.sequence + 1;
    run.journalBytes += bytes;
    return operation._id;
  }

  private async applyOperation(
    operation: RepairOperation,
    cancellation: ArchiveRepairCancellation,
    beforeWrite?: () => void,
  ): Promise<void> {
    await cancellation.checkpoint();
    await this.dependencies.assertOwner();
    const operations = this.db().collection<RepairOperation>(REPAIR_OPERATIONS);
    if (operation.state === 'verified') return;
    for (const dependency of operation.dependencies) {
      if ((await operations.countDocuments({ _id: dependency, state: 'verified' })) !== 1) {
        throw new Error(`Unverified dependency ${dependency}`);
      }
    }
    const bytes = operation.after === null ? 0 : mongo.BSON.calculateObjectSize(operation.after);
    const commit = async (): Promise<void> => {
      await cancellation.checkpoint();
      // Durable before-image exists before mutation. Replays recognize already-written after-images.
      const staged = await operations.updateOne(
        { _id: operation._id, state: { $in: ['planned', 'journaled'] } },
        { $set: { state: 'journaled' } },
      );
      if (!staged.acknowledged || staged.matchedCount !== 1)
        throw new Error('Repair journal changed before mutation');
      const collection = this.db().collection<RepairDocument>(operation.collection);
      const current = await collection.findOne({
        $expr: { $eq: ['$_id', { $literal: operation.documentId }] },
      });
      await cancellation.checkpoint();
      const hash = repairHash(current);
      if (hash !== operation.afterHash) {
        if (hash !== operation.beforeHash)
          throw new Error(`Stale operation ${operation._id}; replan required`);
        beforeWrite?.();
        if (operation.before === null) {
          if (operation.after === null) throw new Error('Empty repair operation');
          await collection.insertOne(operation.after);
        } else {
          const filter = {
            _id: { $eq: operation.documentId },
            $expr: { $eq: ['$$ROOT', { $literal: operation.before }] },
          } as mongo.Filter<RepairDocument>;
          const result =
            operation.after === null
              ? await collection.deleteOne(filter)
              : await collection.replaceOne(filter, operation.after);
          const affected = 'deletedCount' in result ? result.deletedCount : result.matchedCount;
          if (affected !== 1) throw new Error(`Concurrent change in operation ${operation._id}`);
        }
      }
      const verified = await collection.findOne({
        $expr: { $eq: ['$_id', { $literal: operation.documentId }] },
      });
      if (repairHash(verified) !== operation.afterHash)
        throw new Error(`After-image verification failed ${operation._id}`);
      const acknowledged = await operations.updateOne(
        { _id: operation._id, state: 'journaled' },
        { $set: { state: 'verified' } },
      );
      if (!acknowledged.acknowledged || acknowledged.matchedCount !== 1)
        throw new Error('Repair journal acknowledgement failed');
    };
    if (this.dependencies.withCapacity !== undefined)
      await this.dependencies.withCapacity(bytes, commit);
    else {
      await this.dependencies.ensureCapacity(bytes);
      await commit();
    }
  }

  /** Intercept all enrichment relationship mutations through this journaled writer. */
  async captureMutation(
    runId: string,
    collection: string,
    before: RepairDocument | null,
    after: RepairDocument | null,
    reason: string,
    cancellation: ArchiveRepairCancellation,
  ): Promise<void> {
    const mutation = this.mutationTail.then(async () => {
      await cancellation.checkpoint();
      const run = await this.db()
        .collection<RepairRun>(REPAIR_RUNS)
        .findOne({ _id: runId, deleteRequestedAt: { $exists: false } });
      if (run === null || run.status !== 'enriching')
        throw new Error('Repair run is not accepting enrichment writes');
      const journal = this.planningJournals.get(runId);
      if (journal === undefined && run.journalVersion === 2)
        throw new Error('Repair enrichment sequencing authority is unavailable');
      const journalStarted = performance.now();
      const id = await this.addOperation(
        cancellation,
        journal?.run ?? run,
        collection,
        before,
        after,
        reason,
        [],
      );
      if (journal !== undefined) await journal.flush();
      else
        await this.db()
          .collection<RepairRun>(REPAIR_RUNS)
          .updateOne(
            { _id: runId },
            { $set: { operations: run.operations, journalBytes: run.journalBytes } },
          );
      const operation = await this.db()
        .collection<RepairOperation>(REPAIR_OPERATIONS)
        .findOne({ _id: id });
      if (operation === null) throw new Error('Repair journal persistence failed');
      const journalMs = performance.now() - journalStarted;
      const writingStarted = performance.now();
      let verified = 0;
      try {
        await this.applyOperation(operation, cancellation);
        verified = 1;
      } finally {
        this.reportEnrichmentBatch({
          operations: 1,
          verified,
          journalMs,
          writeVerifyMs: performance.now() - writingStarted,
        });
      }
    });
    this.mutationTail = mutation.catch(() => undefined);
    await mutation;
  }

  private reportEnrichmentBatch(metric: RepairEnrichmentBatchMetric): void {
    try {
      this.dependencies.onEnrichmentBatch?.(metric);
    } catch {
      // Observability must not change an acknowledged archive mutation.
    }
  }

  /** Prepared mutations retain message-local ordering while independent documents share a durable batch. */
  async captureMutations(
    runId: string,
    mutations: readonly RepairMutation[],
    cancellation: ArchiveRepairCancellation,
    beforeWrite?: () => void,
  ): Promise<void> {
    if (mutations.length > ARCHIVE_LIMITS.batchDocuments)
      throw new RangeError('Repair enrichment batch exceeds document limit');
    let bytes = 0;
    const prepared = mutations.map((mutation) => {
      bytes += mongo.BSON.calculateObjectSize(mutation);
      if (bytes > ARCHIVE_LIMITS.batchBytes)
        throw new RangeError('Repair enrichment batch exceeds byte limit');
      return clone({ ...mutation });
    });
    if (prepared.length === 0) return;
    const mutation = this.mutationTail.then(async () => {
      await cancellation.checkpoint();
      const run = await this.db()
        .collection<RepairRun>(REPAIR_RUNS)
        .findOne({ _id: runId, deleteRequestedAt: { $exists: false } });
      if (run === null || run.status !== 'enriching')
        throw new Error('Repair run is not accepting enrichment writes');
      const journal = this.planningJournals.get(runId);
      if (journal === undefined && run.journalVersion === 2)
        throw new Error('Repair enrichment sequencing authority is unavailable');
      const operations = this.db().collection<RepairOperation>(REPAIR_OPERATIONS);
      const journalStarted = performance.now();
      const ids: string[] = [];
      const previousByScope = new Map<string, string>();
      for (const entry of prepared) {
        const messageId = entry.after?.['messageId'] ?? entry.before?.['messageId'];
        const scope =
          typeof messageId === 'string' && messageId.length > 0
            ? `message:${messageId}`
            : `${entry.collection}:${repairHash({ documentId: (entry.before ?? entry.after)?._id })}`;
        const previous = previousByScope.get(scope);
        const id = await this.addOperation(
          cancellation,
          journal?.run ?? run,
          entry.collection,
          entry.before,
          entry.after,
          entry.reason,
          previous === undefined ? [] : [previous],
        );
        if (!ids.includes(id)) ids.push(id);
        previousByScope.set(scope, id);
        if (journal === undefined) {
          await this.db()
            .collection<RepairRun>(REPAIR_RUNS)
            .updateOne(
              { _id: runId },
              { $set: { operations: run.operations, journalBytes: run.journalBytes } },
            );
          const operation = await operations.findOne({ _id: id });
          if (operation === null) throw new Error('Repair journal persistence failed');
          await this.applyOperation(operation, cancellation, beforeWrite);
        }
      }
      if (journal === undefined) return;
      await journal.flush();
      const persisted = await operations
        .find({ _id: { $in: ids }, runId })
        .sort({ sequence: 1 })
        .toArray();
      if (persisted.length !== ids.length) throw new Error('Repair journal persistence failed');
      const pending = persisted.filter((operation) => operation.state !== 'verified');
      const journalMs = performance.now() - journalStarted;
      const writingStarted = performance.now();
      const result = await applyRepairBatch(
        this.db(),
        pending,
        this.dependencies,
        cancellation,
        beforeWrite,
      );
      this.reportEnrichmentBatch({
        operations: pending.length,
        verified: result.verified,
        journalMs,
        writeVerifyMs: performance.now() - writingStarted,
      });
      if (result.failure !== undefined) throw result.failure;
    });
    this.mutationTail = mutation.catch(() => undefined);
    await mutation;
  }

  private async apply(
    run: RepairRun,
    request: RepairRequest,
    cancellation: ArchiveRepairCancellation,
  ): Promise<RepairResult> {
    if (
      ['accepted', 'rolled-back', 'rolling-back', 'failed-plan', 'planning'].includes(run.status)
    ) {
      throw new Error(`Cannot apply run in ${run.status} state`);
    }
    if (['planned', 'partial-plan'].includes(run.status) && this.now() > run.validUntil)
      throw new Error('Repair manifest expired; replan required');
    const runs = this.db().collection<RepairRun>(REPAIR_RUNS);
    const operations = this.db().collection<RepairOperation>(REPAIR_OPERATIONS);
    await this.dependencies.ensureCapacity(run.journalBytes);
    await cancellation.checkpoint();
    await runs.updateOne({ _id: run._id }, { $set: { status: 'applying' } });
    let applied = 0;
    const pendingTotal = await operations.countDocuments({
      runId: run._id,
      state: { $ne: 'verified' },
    });
    await this.dependencies.onProgress?.('repair', 0, pendingTotal, 'apply', {
      quality: 'exact',
      unit: 'operations',
      substep: 'apply-manifest',
    });
    const cursor = operations
      .find({ runId: run._id, state: { $ne: 'verified' } })
      .sort({ sequence: 1 })
      .batchSize(ARCHIVE_LIMITS.batchDocuments);
    try {
      let batch: RepairOperation[] = [];
      let batchBytes = 0;
      const flushBatch = async (): Promise<void> => {
        if (batch.length === 0) return;
        const result = await applyRepairBatch(this.db(), batch, this.dependencies, cancellation);
        applied += result.verified;
        await this.dependencies.onProgress?.('repair', applied, pendingTotal, 'apply', {
          quality: 'exact',
          unit: 'operations',
          substep: 'apply-manifest',
        });
        batch = [];
        batchBytes = 0;
        if (result.failure !== undefined) throw result.failure;
      };
      for await (const operation of cursor) {
        await cancellation.checkpoint();
        if (run.journalVersion !== 2) {
          await this.applyOperation(operation, cancellation);
          applied += 1;
          if (applied % 100 === 0)
            await this.dependencies.onProgress?.('repair', applied, pendingTotal, 'apply', {
              quality: 'exact',
              unit: 'operations',
              substep: 'apply-manifest',
            });
          continue;
        }
        const bytes = mongo.BSON.calculateObjectSize(operation);
        if (
          batch.length > 0 &&
          (batch.length >= ARCHIVE_LIMITS.batchDocuments ||
            batchBytes + bytes > ARCHIVE_LIMITS.batchBytes)
        )
          await flushBatch();
        batch.push(operation);
        batchBytes += bytes;
        if (
          batch.length >= ARCHIVE_LIMITS.batchDocuments ||
          batchBytes >= ARCHIVE_LIMITS.batchBytes
        )
          await flushBatch();
      }
      await flushBatch();
      await this.dependencies.onProgress?.('repair', applied, pendingTotal, 'apply', {
        quality: 'exact',
        unit: 'operations',
        substep: 'apply-manifest',
      });
      await cancellation.checkpoint();
      await this.createIndexes(cancellation);
      await cancellation.checkpoint();
      await runs.updateOne({ _id: run._id }, { $set: { status: 'enriching' } });
      if (run.journalVersion === 2)
        this.planningJournals.set(
          run._id,
          new ArchiveRepairPlanningJournal(this.db(), run, this.dependencies, cancellation),
        );
      await cancellation.checkpoint();
      const coverage: RepairResult =
        run.timestampsOnly === true
          ? { status: 'complete', counts: {}, issues: [], details: { scope: 'timestamps-only' } }
          : await this.dependencies.backfill({
              runId: run._id,
              cutoff: run.cutoff,
              jobId: request.jobId,
              applyMutation: (collection, before, after, reason) =>
                this.captureMutation(run._id, collection, before, after, reason, cancellation),
              applyMutations: (mutations, beforeWrite) =>
                this.captureMutations(run._id, mutations, cancellation, beforeWrite),
            });
      await runs.updateOne(
        { _id: run._id },
        { $set: { coverage, status: coverage.status === 'complete' ? 'verifying' : 'partial' } },
      );
      const current = await this.requireRun(run._id, request.guildId);
      return this.verify(current, cancellation);
    } catch (error: unknown) {
      const issue = error instanceof Error ? error.message : String(error);
      await runs.updateOne(
        { _id: run._id },
        { $set: { status: 'partial', issues: [...run.issues.slice(0, 99), issue] } },
      );
      return {
        status: cancellation.isCancelled() ? 'cancelled' : 'partial',
        runId: run._id,
        counts: { applied },
        issues: [issue],
      };
    } finally {
      this.planningJournals.delete(run._id);
      await cursor.close();
    }
  }

  private async ensureRepairIndexes(cancellation: ArchiveRepairCancellation): Promise<void> {
    await this.dependencies.assertOwner();
    await cancellation.checkpoint();
    await this.db()
      .collection(REPAIR_OPERATIONS)
      .createIndex({ runId: 1, sequence: 1 }, { unique: true });
    await cancellation.checkpoint();
    await this.db().collection(REPAIR_RUNS).createIndex({ guildId: 1, status: 1, expiresAt: 1 });
    await cancellation.checkpoint();
    await this.db().collection('archive_quarantine').createIndex({ runId: 1, messageId: 1 });
    await cancellation.checkpoint();
    await this.db().collection('archive_repair_conflicts').createIndex({ runId: 1 });
  }

  private async createIndexes(cancellation: ArchiveRepairCancellation): Promise<void> {
    await this.dependencies.assertOwner();
    await cancellation.checkpoint();
    const collection = this.db().collection<RepairDocument>(MESSAGES);
    const indexes = await collection
      .listIndexes()
      .toArray()
      .catch((error: unknown) => {
        if (error instanceof mongo.MongoServerError && error.code === 26) return [];
        throw error;
      });
    const specifications = [
      { key: { messageId: 1 }, name: 'messageId_1', unique: true },
      { key: { timestamp: 1 }, name: 'timestamp_1', unique: false },
      { key: { channelId: 1, timestamp: 1 }, name: 'channelId_1_timestamp_1', unique: false },
    ] as const;
    const missing = specifications.filter(
      (specification) =>
        !indexes.some(
          (index) =>
            JSON.stringify(index.key) === JSON.stringify(specification.key) &&
            (specification.unique ? index.unique === true : true) &&
            index.sparse !== true &&
            index.partialFilterExpression === undefined,
        ),
    );
    if (missing.length === 0) return;
    const count = await collection.estimatedDocumentCount();
    const statistics =
      count === 0
        ? { size: 0, totalIndexSize: 0 }
        : await this.db().command({ collStats: MESSAGES, scale: 1 });
    // This intentionally overestimates key staging and final indexes; it is not an exact disk prediction.
    const peakBytes =
      Number(statistics['size'] ?? 0) +
      Number(statistics['totalIndexSize'] ?? 0) +
      count * 512 * missing.length +
      (count > 0 ? 64 * 1024 * 1024 * missing.length : 0);
    const build = async (): Promise<void> => {
      for (const specification of missing) {
        await cancellation.checkpoint();
        const conflict = indexes.find((index) => index.name === specification.name);
        if (conflict !== undefined) await collection.dropIndex(specification.name);
        await cancellation.checkpoint();
        await collection.createIndex(specification.key, {
          name: specification.name,
          ...(specification.unique ? { unique: true } : {}),
        });
      }
    };
    if (this.dependencies.withCapacity !== undefined)
      await this.dependencies.withCapacity(peakBytes, build);
    else {
      await this.dependencies.ensureCapacity(peakBytes);
      await build();
    }
  }

  private async verify(
    run: RepairRun,
    cancellation: ArchiveRepairCancellation,
  ): Promise<RepairResult> {
    const audit = await this.audit(cancellation, 'verification', 'verify-audit');
    await cancellation.checkpoint();
    const operations = this.db().collection<RepairOperation>(REPAIR_OPERATIONS);
    const facts = await operations
      .aggregate<{
        total: number;
        pending: number;
        inserted: number;
        deleted: number;
        modified: number;
      }>([
        { $match: { runId: run._id } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            pending: { $sum: { $cond: [{ $ne: ['$state', 'verified'] }, 1, 0] } },
            inserted: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$state', 'verified'] },
                      { $eq: ['$collection', MESSAGES] },
                      { $eq: ['$before', null] },
                      { $ne: ['$after', null] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            deleted: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$state', 'verified'] },
                      { $eq: ['$collection', MESSAGES] },
                      { $ne: ['$before', null] },
                      { $eq: ['$after', null] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            modified: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$state', 'verified'] },
                      { $eq: ['$collection', MESSAGES] },
                      { $ne: ['$before', null] },
                      { $ne: ['$after', null] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ])
      .next();
    const { pending, inserted, deleted, modified } = facts ?? {
      pending: 0,
      inserted: 0,
      deleted: 0,
      modified: 0,
    };
    let invalidManifestOperations = 0;
    let checkedOperations = 0;
    await this.dependencies.onProgress?.('verification', 0, facts?.total ?? 0, 'verify-manifest', {
      quality: 'exact',
      unit: 'operations',
      substep: 'validate-manifest',
    });
    let missingDependencies = 0;
    const pendingDependencies = new Set<string>();
    const checkDependencies = async (): Promise<void> => {
      if (pendingDependencies.size === 0) return;
      await cancellation.checkpoint();
      const states = await operations
        .find(
          { _id: { $in: [...pendingDependencies] } },
          { projection: { _id: 1, state: 1, runId: 1 } },
        )
        .toArray();
      const confirmed = new Set(
        states
          .filter((dependency) => dependency.state === 'verified' && dependency.runId === run._id)
          .map((dependency) => dependency._id),
      );
      for (const dependency of pendingDependencies)
        if (!confirmed.has(dependency)) missingDependencies += 1;
      pendingDependencies.clear();
    };
    const manifestCursor = operations
      .find({ runId: run._id })
      .batchSize(ARCHIVE_LIMITS.batchDocuments);
    try {
      for await (const operation of manifestCursor) {
        await cancellation.checkpoint();
        const beforeHash = repairHash(operation.before);
        const afterHash = repairHash(operation.after);
        const identity = `${run._id}:${repairHash({ collection: operation.collection, documentId: operation.documentId, beforeHash, afterHash, reason: operation.reason })}`;
        if (
          beforeHash !== operation.beforeHash ||
          afterHash !== operation.afterHash ||
          identity !== operation._id
        )
          invalidManifestOperations += 1;
        if (
          !Array.isArray(operation.dependencies) ||
          operation.dependencies.some((dependency) => typeof dependency !== 'string')
        )
          invalidManifestOperations += 1;
        else
          for (const dependency of operation.dependencies) {
            pendingDependencies.add(dependency);
            if (pendingDependencies.size >= ARCHIVE_LIMITS.batchDocuments)
              await checkDependencies();
          }
        checkedOperations += 1;
        if (checkedOperations % ARCHIVE_LIMITS.batchDocuments === 0)
          await this.dependencies.onProgress?.(
            'verification',
            checkedOperations,
            facts?.total ?? checkedOperations,
            'verify-manifest',
            {
              quality: 'exact',
              unit: 'operations',
              substep: 'validate-manifest',
            },
          );
      }
      await checkDependencies();
    } finally {
      await manifestCursor.close();
    }
    await this.dependencies.onProgress?.(
      'verification',
      checkedOperations,
      checkedOperations,
      'verify-manifest',
      {
        quality: 'exact',
        unit: 'operations',
        substep: 'validate-manifest',
      },
    );
    await cancellation.checkpoint();
    const issues: string[] = [];
    if ((audit.counts['invalid'] ?? 0) > 0)
      issues.push('Invalid message identities or timestamps remain');
    if ((audit.counts['duplicateGroups'] ?? 0) > 0) issues.push('Duplicate messages remain');
    if (
      run.timestampsOnly !== true &&
      ((audit.counts['invalidCursors'] ?? 0) > 0 || (audit.counts['duplicateCursors'] ?? 0) > 0)
    )
      issues.push('Invalid or duplicate legacy cursors remain');
    if (run.timestampsOnly !== true && (audit.counts['excluded'] ?? 0) > 0)
      issues.push('New policy-excluded candidates require a new approved manifest');
    if (pending > 0) issues.push('Unverified repair operations remain');
    if (invalidManifestOperations > 0)
      issues.push('Repair manifest image or operation identity is invalid');
    if ((facts?.total ?? 0) !== run.operations)
      issues.push('Repair manifest operation count requires recovery');
    if (missingDependencies > 0)
      issues.push('Repair manifest dependencies are unverified or missing');
    if (audit.details?.['uniqueIndex'] !== true) issues.push('Unique message index is unavailable');
    if (run.coverage?.status !== 'complete')
      issues.push('Discord coverage or reactions are incomplete');
    let unresolvedEvidence = 0;
    const evidenceCursor = this.db()
      .collection<RepairDocument>('archive_quarantine')
      .find({ runId: run._id }, { projection: { messageId: 1 } })
      .batchSize(ARCHIVE_LIMITS.batchDocuments);
    let evidenceBatch: RepairDocument[] = [];
    const checkEvidence = async (): Promise<void> => {
      if (evidenceBatch.length === 0) return;
      await cancellation.checkpoint();
      const identities = evidenceBatch.map((evidence) => evidence['messageId']).filter(validId);
      const current =
        identities.length === 0
          ? []
          : await this.db()
              .collection<RepairDocument>(MESSAGES)
              .find(
                { messageId: { $in: identities }, schemaVersion: 2 },
                { projection: { messageId: 1 } },
              )
              .toArray();
      await cancellation.checkpoint();
      const readable = new Set(current.map((document) => document['messageId']));
      for (const evidence of evidenceBatch)
        if (!validId(evidence['messageId']) || !readable.has(evidence['messageId']))
          unresolvedEvidence += 1;
      evidenceBatch = [];
    };
    try {
      for await (const evidence of evidenceCursor) {
        await cancellation.checkpoint();
        evidenceBatch.push(evidence);
        if (evidenceBatch.length >= ARCHIVE_LIMITS.batchDocuments) await checkEvidence();
      }
      await checkEvidence();
    } finally {
      await evidenceCursor.close();
    }
    if (unresolvedEvidence > 0)
      issues.push('Quarantined candidates remain unresolved by readable source');
    await cancellation.checkpoint();
    const status = issues.length === 0 ? 'complete' : 'partial';
    if (!['accepted', 'rolled-back', 'rolling-back'].includes(run.status)) {
      await this.db()
        .collection<RepairRun>(REPAIR_RUNS)
        .updateOne({ _id: run._id }, { $set: { status, verifiedAt: this.now() } });
    }
    return {
      status,
      runId: run._id,
      counts: {
        ...audit.counts,
        pending,
        unresolvedEvidence,
        inserted,
        deleted,
        modified,
        invalidManifestOperations,
        missingDependencies,
      },
      issues,
      details: { coverage: run.coverage },
    };
  }

  private rollbackScope(operation: RepairOperation): string {
    const messageId = operation.after?.['messageId'] ?? operation.before?.['messageId'];
    return typeof messageId === 'string' && messageId.length > 0
      ? `message:${messageId}`
      : `${operation.collection}:${repairHash({ documentId: operation.documentId })}`;
  }

  private async preflightRollback(
    run: RepairRun,
    cancellation: ArchiveRepairCancellation,
  ): Promise<void> {
    const conflicts = this.db().collection<{ _id: string; runId: string; scope: string }>(
      'archive_repair_conflicts',
    );
    await conflicts.deleteMany({ runId: run._id });
    const latest = this.db()
      .collection<RepairOperation>(REPAIR_OPERATIONS)
      .aggregate<RepairOperation>(
        [
          { $match: { runId: run._id, state: { $in: ['verified', 'journaled', 'conflict'] } } },
          { $sort: { sequence: -1 } },
          {
            $group: {
              _id: { collection: '$collection', documentId: '$documentId' },
              operation: { $first: '$$ROOT' },
            },
          },
          { $replaceRoot: { newRoot: '$operation' } },
        ],
        { allowDiskUse: true, cursor: { batchSize: 100 } },
      );
    let batch: RepairOperation[] = [];
    let batchBytes = 0;
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      await cancellation.checkpoint();
      const observations = await readRepairTargets(this.db(), batch);
      const conflicting = new Set<string>();
      for (const operation of batch) {
        const hash = repairHash(observations.get(operation._id) ?? null);
        if (hash !== operation.afterHash && hash !== operation.beforeHash)
          conflicting.add(this.rollbackScope(operation));
      }
      await cancellation.checkpoint();
      if (conflicting.size > 0)
        await conflicts.bulkWrite(
          [...conflicting].map((scope) => ({
            updateOne: {
              filter: { _id: `${run._id}:${scope}` },
              update: { $setOnInsert: { runId: run._id, scope } },
              upsert: true,
            },
          })),
          { ordered: true, writeConcern: { w: 'majority', j: true } },
        );
      batch = [];
      batchBytes = 0;
    };
    try {
      for await (const operation of latest) {
        await cancellation.checkpoint();
        const bytes = mongo.BSON.calculateObjectSize(operation);
        if (
          batch.length > 0 &&
          (batch.length >= ARCHIVE_LIMITS.batchDocuments ||
            batchBytes + bytes > ARCHIVE_LIMITS.batchBytes)
        )
          await flush();
        batch.push(operation);
        batchBytes += bytes;
        if (
          batch.length >= ARCHIVE_LIMITS.batchDocuments ||
          batchBytes >= ARCHIVE_LIMITS.batchBytes
        )
          await flush();
      }
      await flush();
    } finally {
      await latest.close();
    }
  }

  private async rollback(
    run: RepairRun,
    cancellation: ArchiveRepairCancellation,
  ): Promise<RepairResult> {
    if (run.expiresAt !== undefined && this.now() >= run.expiresAt)
      throw new Error('Repair recovery retention expired');
    const runs = this.db().collection<RepairRun>(REPAIR_RUNS);
    const operations = this.db().collection<RepairOperation>(REPAIR_OPERATIONS);
    await cancellation.checkpoint();
    await runs.updateOne(
      { _id: run._id },
      { $set: { status: 'rolling-back' }, $unset: { expiresAt: '' } },
    );
    let restored = 0;
    let conflicts = 0;
    const rollbackTotal = await operations.countDocuments({
      runId: run._id,
      state: { $in: ['verified', 'journaled', 'conflict'] },
    });
    let processed = 0;
    await this.dependencies.onProgress?.('repair', 0, rollbackTotal, 'rollback', {
      quality: 'exact',
      unit: 'operations',
      substep: 'rollback-manifest',
      outcomes: { restored, conflicts, skipped: 0 },
    });
    await this.preflightRollback(run, cancellation);
    let indexDropped = false;
    let retainedRevisions = 0;
    const cursor = operations
      .find({ runId: run._id, state: { $in: ['verified', 'journaled', 'conflict'] } })
      .sort({ sequence: -1 })
      .batchSize(ARCHIVE_LIMITS.batchDocuments);
    try {
      for await (const operation of cursor) {
        await cancellation.checkpoint();
        processed += 1;
        if (processed % 100 === 0)
          await this.dependencies.onProgress?.('repair', processed, rollbackTotal, 'rollback', {
            quality: 'exact',
            unit: 'operations',
            substep: 'rollback-manifest',
            outcomes: { restored, conflicts, skipped: retainedRevisions },
          });
        await this.dependencies.assertOwner();
        const scope = this.rollbackScope(operation);
        if (
          (await this.db()
            .collection<{ _id: string }>('archive_repair_conflicts')
            .countDocuments({ _id: `${run._id}:${scope}` })) > 0
        ) {
          conflicts += 1;
          await operations.updateOne({ _id: operation._id }, { $set: { state: 'conflict' } });
          continue;
        }
        // Observed edit versions are permanent evidence even when enrichment is rolled back.
        if (
          operation.collection === 'archive_revisions' &&
          operation.before === null &&
          operation.after !== null
        ) {
          await operations.updateOne(
            { _id: operation._id },
            { $set: { state: 'rolled-back', retainedObservedVersion: true } },
          );
          retainedRevisions += 1;
          continue;
        }
        const collection = this.db().collection<RepairDocument>(operation.collection);
        const current = await collection.findOne({
          $expr: { $eq: ['$_id', { $literal: operation.documentId }] },
        });
        await cancellation.checkpoint();
        if (repairHash(current) === operation.beforeHash) {
          await operations.updateOne({ _id: operation._id }, { $set: { state: 'rolled-back' } });
          continue;
        }
        if (repairHash(current) !== operation.afterHash) {
          conflicts += 1;
          await operations.updateOne({ _id: operation._id }, { $set: { state: 'conflict' } });
          continue;
        }
        const bytes =
          operation.before === null ? 0 : mongo.BSON.calculateObjectSize(operation.before);
        const restore = async (): Promise<boolean> => {
          await cancellation.checkpoint();
          if (operation.after === null) {
            if (operation.before !== null) {
              if (!indexDropped && operation.collection === MESSAGES) {
                const existing = await collection.findOne({
                  messageId: operation.before['messageId'],
                });
                if (
                  existing !== null &&
                  repairHash({ _id: existing._id }) !== repairHash({ _id: operation.before._id })
                ) {
                  const indexes = await collection.listIndexes().toArray();
                  for (const index of indexes) {
                    if (
                      index.unique === true &&
                      index.key['messageId'] === 1 &&
                      Object.keys(index.key).length === 1 &&
                      index.name !== undefined
                    ) {
                      await collection.dropIndex(index.name);
                      indexDropped = true;
                    }
                  }
                }
              }
              await collection.insertOne(operation.before);
            }
          } else {
            const filter = {
              _id: { $eq: operation.documentId },
              $expr: { $eq: ['$$ROOT', { $literal: current }] },
            } as unknown as mongo.Filter<RepairDocument>;
            const result =
              operation.before === null
                ? await collection.deleteOne(filter)
                : await collection.replaceOne(filter, operation.before);
            if (('deletedCount' in result ? result.deletedCount : result.matchedCount) !== 1) {
              return false;
            }
          }
          if (
            repairHash(
              await collection.findOne({
                $expr: { $eq: ['$_id', { $literal: operation.documentId }] },
              }),
            ) !== operation.beforeHash
          ) {
            throw new Error(`Rollback verification failed ${operation._id}`);
          }
          await operations.updateOne({ _id: operation._id }, { $set: { state: 'rolled-back' } });
          return true;
        };
        let succeeded: boolean;
        if (this.dependencies.withCapacity !== undefined)
          succeeded = await this.dependencies.withCapacity(bytes, restore);
        else {
          await this.dependencies.ensureCapacity(bytes);
          succeeded = await restore();
        }
        if (succeeded) restored += 1;
        else conflicts += 1;
      }
      await this.dependencies.onProgress?.('repair', processed, rollbackTotal, 'rollback', {
        quality: 'exact',
        unit: 'operations',
        substep: 'rollback-manifest',
        outcomes: { restored, conflicts, skipped: retainedRevisions },
      });
      await cancellation.checkpoint();
      const status = conflicts === 0 ? 'rolled-back' : 'rollback-conflicts';
      await runs.updateOne({ _id: run._id }, { $set: { status } });
      return {
        status: conflicts === 0 ? 'complete' : 'partial',
        runId: run._id,
        counts: { restored, conflicts, retainedRevisions },
        issues:
          conflicts === 0 ? [] : ['Later changes preserved; rollback conflicts require review'],
        details: { requiresStructuralRepair: indexDropped },
      };
    } finally {
      await cursor.close();
    }
  }

  private async accept(
    run: RepairRun,
    cancellation: ArchiveRepairCancellation,
  ): Promise<RepairResult> {
    if (run.status === 'accepted')
      return {
        status: 'complete',
        runId: run._id,
        counts: {},
        issues: [],
        details: { acceptedAt: run.acceptedAt, expiresAt: run.expiresAt },
      };
    if (run.status !== 'complete')
      throw new Error('Only a verified complete repair can be accepted');
    const verified = await this.verify(run, cancellation);
    if (verified.status !== 'complete') return verified;
    await cancellation.checkpoint();
    const acceptedAt = this.now();
    await this.db()
      .collection<RepairRun>(REPAIR_RUNS)
      .updateOne(
        { _id: run._id, status: 'complete' },
        { $set: { status: 'accepted', acceptedAt, expiresAt: acceptedAt + RETENTION_MS } },
      );
    return { ...verified, details: { acceptedAt, expiresAt: acceptedAt + RETENTION_MS } };
  }

  /** Cleanup is explicit and ignores every unaccepted, failed, or active rollback run. */
  async cleanupAccepted(): Promise<number> {
    await this.dependencies.assertOwner();
    let removed = 0;
    const runs = this.db().collection<RepairRun>(REPAIR_RUNS);
    const cursor = runs
      .find({ status: 'accepted', expiresAt: { $lte: this.now() } })
      .batchSize(ARCHIVE_LIMITS.batchDocuments);
    try {
      for await (const run of cursor) {
        await this.db()
          .collection<RepairOperation>(REPAIR_OPERATIONS)
          .deleteMany({ runId: run._id });
        await this.db().collection('archive_quarantine').deleteMany({ runId: run._id });
        await this.db().collection('archive_repair_conflicts').deleteMany({ runId: run._id });
        await runs.updateOne(
          { _id: run._id, status: 'accepted' },
          { $set: { status: 'recovery-expired', recoveryExpiredAt: this.now() } },
        );
        removed += 1;
      }
    } finally {
      await cursor.close();
    }
    return removed;
  }
}
