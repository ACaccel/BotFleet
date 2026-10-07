import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mongo, type Connection } from 'mongoose';
import { z } from 'zod';
import type { ArchiveJob } from '../../core/archive/types';
import {
  archiveManifestCategories,
  archiveManifestCollections,
  archiveManifestCategory,
  archiveManifestCategoryExpression,
} from '../../core/archive/manifest-summary';
import type {
  ArchiveManifestCategory,
  ArchiveManifestCategorySummary,
  ArchiveManifestImpact,
  ArchiveManifestSummary,
  ArchiveManifestRecordTypeSummary,
} from '../../core/archive/manifest-summary';
import {
  archiveJobProgress,
  sanitizeArchiveProgress,
  safeArchiveName,
} from '../../core/archive/progress';
import type { ArchiveProgressSnapshot, ArchiveScopeGap } from '../../core/archive/progress';
import {
  safeArchiveOperationTarget,
  safeArchiveOperationChanges,
  type ArchiveOperationSummary,
  type ArchiveManifestGroupFilter,
  type ArchiveManifestGroup,
  type ArchiveManifestPage,
  type ArchiveManifestSource,
} from '../../core/archive/manifest-target';
import {
  archiveManifestFilter,
  archiveOperationImpactExpression,
  archiveOperationSourceExpression,
  archiveOperationProjection,
  MANIFEST_QUERY_TIMEOUT_MS,
} from './manifest-query';
import {
  ArchiveManifestQueries,
  archiveManifestGroupSchema,
  archiveManifestSourceSchema,
} from './manifest-groups';
import { withArchivePublicMessageLock } from './public-message';
import {
  archiveJobDeletions,
  finalizeArchiveJobDeletion,
  releaseArchiveRunConsumer,
  reserveArchiveRunConsumer,
} from './lifecycle';

const id = z.string().regex(/^\d{1,20}$/);
const reference = z.string().regex(/^[A-Za-z0-9:_-]{1,160}$/);
const confirmedActions = ['apply', 'resume', 'rollback', 'accept'] as const;
const deletablePlanStatuses = ['planned', 'partial-plan', 'failed-plan', 'rolled-back'];
type ArchiveConfirmedAction = (typeof confirmedActions)[number];
type ArchiveIssueCategory =
  | 'permission'
  | 'capacity'
  | 'coverage'
  | 'conflict'
  | 'expired'
  | 'settings-changed'
  | 'other';
interface ArchiveJobSummary {
  jobId: string;
  requestId: string;
  guildId: string;
  command: ArchiveJob['command'];
  runId?: string;
  status: ArchiveJob['status'];
  cancelRequested: boolean;
  deleteRequestedAt?: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  counts: Record<string, number>;
  issueCount: number;
  issueCategories: ArchiveIssueCategory[];
  progress: ArchiveProgressSummary;
  attachment?: { channelId: string; messageId: string; attachmentId: string };
}
interface ArchiveRunSummary {
  deletable: boolean;
  runId: string;
  guildId: string;
  status: string;
  createdAt: number;
  cutoff: number;
  policyHash?: string;
  schemaHash?: string;
  journalVersion?: 1 | 2;
  validUntil?: number;
  acceptedAt?: number;
  expiresAt?: number;
  operations: number;
  unresolved: number;
  journalBytes: number;
  issueCount: number;
  issueCategories: ArchiveIssueCategory[];
  actions: ArchiveConfirmedAction[];
  verification?: ArchiveRunVerification;
  scope?: {
    timestampsOnly?: boolean;
    policy: 'unavailable';
    historyDiscovery: 'pending' | 'complete' | 'unknown';
  };
}
interface ArchiveRunVerification {
  status: 'complete' | 'partial' | 'failed' | 'cancelled';
  checkedAt?: number;
  unresolved?: number;
  issueCount: number;
  issueCategories: ArchiveIssueCategory[];
}
type ArchiveProgressSummary = ArchiveProgressSnapshot;
interface RunDocument extends Record<string, unknown> {
  _id: string;
  guildId: string;
  status: string;
  policyHash?: string;
  schemaHash?: string;
  validUntil?: number;
}
interface ConfirmationDocument {
  _id: string;
  guildId: string;
  userId: string;
  channelId: string;
  action: ArchiveConfirmedAction;
  runId: string;
  manifestHash: string;
  requestId: string;
  createdAt: number;
  expiresAt: number;
  consumedAt?: number;
  purgedAt?: number;
}
interface Actor {
  userId: string;
  channelId: string;
}
type Notification = { channelId: string; messageId?: string };
interface SubmitOptions {
  runId?: string;
  channelId?: string;
  messageId?: string;
  attachmentId?: string;
  userId?: string;
  notification?: Notification;
}

const countKeys = new Set([
  'total',
  'convertible',
  'invalid',
  'unknownAuthors',
  'excluded',
  'invalidCursors',
  'duplicateCursors',
  'duplicateGroups',
  'operations',
  'unresolved',
  'journalBytes',
  'applied',
  'pending',
  'unresolvedEvidence',
  'inserted',
  'deleted',
  'modified',
  'updated',
  'restored',
  'conflicts',
  'retainedRevisions',
  'channels',
  'messages',
  'attachments',
  'fetched',
  'archived',
  'inaccessible',
  'gaps',
  'scanned',
  'verified',
  'pendingEvents',
  'refreshed',
]);
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const finite = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const safeReference = (value: unknown): string | undefined => {
  const parsed = reference.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};
const issueSummary = (
  value: unknown,
): {
  issueCount: number;
  issueCategories: ArchiveIssueCategory[];
} => {
  const issues = Array.isArray(value) ? value : [];
  const categories = new Set<ArchiveIssueCategory>();
  for (const issue of issues) {
    const text = typeof issue === 'string' ? issue.toLowerCase() : '';
    categories.add(
      /permission|forbidden|access|denied/.test(text)
        ? 'permission'
        : /capacity|space|enospc|storage/.test(text)
          ? 'capacity'
          : /expired|expiry/.test(text)
            ? 'expired'
            : /settings|policy|schema/.test(text)
              ? 'settings-changed'
              : /conflict|changed|duplicate/.test(text)
                ? 'conflict'
                : /coverage|incomplete|missing|gap|unresolved/.test(text)
                  ? 'coverage'
                  : 'other',
    );
  }
  return { issueCount: issues.length, issueCategories: [...categories] };
};
const safeCounts = (value: unknown): Record<string, number> =>
  Object.fromEntries(
    Object.entries(record(value)).flatMap(([key, count]) =>
      countKeys.has(key) && typeof count === 'number' && Number.isFinite(count) && count >= 0
        ? [[key, count]]
        : [],
    ),
  );

const progressSummary = sanitizeArchiveProgress;
const digest = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
const scalarDocumentId = (value: unknown): string | undefined => {
  if (value instanceof mongo.ObjectId) return value.toHexString();
  if (
    typeof value === 'string' &&
    (/^\d{1,20}$/.test(value) ||
      /^[a-f0-9]{24}$/i.test(value) ||
      /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value))
  )
    return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
};

/** Only fixed metadata and numerical counters may leave the archive control boundary. */
export const safeArchiveJobSummary = (job: ArchiveJob): ArchiveJobSummary => {
  const result = record(job.result);
  const runId = safeReference(job.runId ?? result['runId']);
  const progress = archiveJobProgress(job);
  return {
    jobId: reference.parse(job.jobId),
    requestId: reference.parse(job.requestId),
    guildId: id.parse(job.guildId),
    command: job.command,
    status: job.status,
    cancelRequested: job.cancelRequested,
    ...(typeof job.deleteRequestedAt !== 'number'
      ? {}
      : { deleteRequestedAt: finite(job.deleteRequestedAt) }),
    createdAt: finite(job.createdAt),
    ...(runId === undefined ? {} : { runId }),
    ...(job.startedAt === undefined ? {} : { startedAt: finite(job.startedAt) }),
    ...(job.finishedAt === undefined ? {} : { finishedAt: finite(job.finishedAt) }),
    progress,
    ...(job.command === 'refresh-attachment' &&
    id.safeParse(job.options['channelId']).success &&
    id.safeParse(job.options['messageId']).success &&
    id.safeParse(job.options['attachmentId']).success
      ? {
          attachment: {
            channelId: id.parse(job.options['channelId']),
            messageId: id.parse(job.options['messageId']),
            attachmentId: id.parse(job.options['attachmentId']),
          },
        }
      : {}),
    counts: safeCounts(result['counts']),
    ...issueSummary([
      ...(Array.isArray(result['issues']) ? result['issues'] : []),
      ...(result['error'] === undefined ? [] : [result['error']]),
    ]),
  };
};

export const formatArchiveJobReport = (job: ArchiveJob): string => {
  const summary = safeArchiveJobSummary(job);
  return JSON.stringify(
    {
      status: summary.status,
      runId: summary.runId,
      counts: summary.counts,
      issueCount: summary.issueCount,
      issueCategories: summary.issueCategories,
    },
    null,
    2,
  );
};

const runSummary = (
  run: RunDocument,
  actions: ArchiveConfirmedAction[] = [],
  verification?: ArchiveRunVerification,
): ArchiveRunSummary => ({
  deletable: false,
  runId: reference.parse(run._id),
  guildId: id.parse(run.guildId),
  status: safeReference(run.status) ?? 'unknown',
  createdAt: finite(run['createdAt']),
  cutoff: finite(run['cutoff']),
  ...(digest(run.policyHash) === undefined ? {} : { policyHash: digest(run.policyHash) }),
  ...(run.schemaHash === 'archive-v2' || run.schemaHash === 'archive-v2:journal-v2'
    ? { schemaHash: run.schemaHash }
    : digest(run.schemaHash) === undefined
      ? {}
      : { schemaHash: digest(run.schemaHash) }),
  ...(run['journalVersion'] === undefined || run['journalVersion'] === 1
    ? { journalVersion: 1 as const }
    : run['journalVersion'] === 2
      ? { journalVersion: 2 as const }
      : {}),
  ...(run.validUntil === undefined ? {} : { validUntil: finite(run.validUntil) }),
  ...(run['acceptedAt'] === undefined ? {} : { acceptedAt: finite(run['acceptedAt']) }),
  ...(run['expiresAt'] === undefined ? {} : { expiresAt: finite(run['expiresAt']) }),
  operations: finite(run['operations']),
  unresolved: finite(run['unresolved']),
  journalBytes: finite(run['journalBytes']),
  ...issueSummary(run['issues']),
  actions,
  scope: {
    ...(typeof run['timestampsOnly'] === 'boolean'
      ? { timestampsOnly: run['timestampsOnly'] }
      : {}),
    policy: 'unavailable',
    historyDiscovery: ['planned', 'partial-plan', 'planning'].includes(run.status)
      ? 'pending'
      : record(run['coverage'])['status'] === 'complete'
        ? 'complete'
        : 'unknown',
  },
  ...(verification === undefined ? {} : { verification }),
});
const pageLimit = (limit: number | undefined, maximum: number): number =>
  z
    .number()
    .int()
    .min(1)
    .max(maximum)
    .parse(limit ?? Math.min(20, maximum));
const notificationSchema = z.object({ channelId: id, messageId: id.optional() }).strict();

const emptyManifestImpact = (): ArchiveManifestImpact => ({
  insertOperations: 0,
  updateOperations: 0,
  deleteOperations: 0,
  unknownImpactOperations: 0,
});

/** Discord control only enqueues work; the archive owner performs every archive mutation. */
export class ArchiveControlService {
  public constructor(
    private readonly connection: Connection,
    private readonly guildId: string,
    private readonly settings: { policyHash?: () => string; schemaHash?: string } = {},
  ) {
    id.parse(guildId);
    if (connection.db === undefined) throw new Error('Archive control requires an open database');
  }
  private jobsCollection() {
    return this.connection.collection<ArchiveJob & { _id: string }>('archive_jobs');
  }
  private confirmations() {
    return this.connection.collection<ConfirmationDocument>('archive_control_confirmations');
  }
  private async run(runId: string): Promise<RunDocument> {
    reference.parse(runId);
    const run = await this.connection
      .collection<RunDocument>('archive_repair_runs')
      .findOne({ _id: runId, guildId: this.guildId });
    if (run === null || run['deleteRequestedAt'] !== undefined)
      throw new Error('Unknown repair manifest for this guild');
    return run;
  }
  private eligible(action: ArchiveConfirmedAction | 'verify', run: RunDocument): boolean {
    const status = run.status;
    if (action === 'accept') return status === 'complete';
    if (action === 'apply')
      return (
        ['planned', 'partial-plan'].includes(status) &&
        (run.validUntil === undefined || run.validUntil > Date.now())
      );
    if (action === 'resume')
      return ['applying', 'enriching', 'verifying', 'partial'].includes(status);
    if (action === 'rollback')
      return [
        'applying',
        'enriching',
        'verifying',
        'complete',
        'partial',
        'accepted',
        'rolling-back',
        'rollback-conflicts',
      ].includes(status);
    return !['planning', 'failed-plan', 'rolled-back', 'recovery-expired'].includes(status);
  }
  private assertSettings(run: RunDocument): void {
    if (
      (this.settings.policyHash !== undefined && run.policyHash !== this.settings.policyHash()) ||
      ![undefined, 1, 2].includes(run['journalVersion'] as number | undefined) ||
      run.schemaHash !==
        `${this.settings.schemaHash ?? 'archive-v2'}${run['journalVersion'] === 2 ? ':journal-v2' : ''}`
    )
      throw new Error('Repair settings changed; produce a new manifest');
  }
  private async summarizeManifest(run: RunDocument): Promise<ArchiveManifestSummary> {
    try {
      const countMutation = (mutation: string): Record<string, unknown> => ({
        $sum: { $cond: [{ $eq: ['$mutation', mutation] }, 1, 0] },
      });
      const data = await this.connection
        .collection('archive_repair_operations')
        .aggregate<{
          categories: (ArchiveManifestCategorySummary & { _id: ArchiveManifestCategory })[];
          targets: { distinctSources: number; unknownSourceOperations: number }[];
          recordTypes: (ArchiveManifestRecordTypeSummary & { _id: string })[];
        }>(
          [
            { $match: { runId: run._id } },
            {
              $project: {
                _id: 0,
                category: archiveManifestCategoryExpression(),
                mutation: archiveOperationImpactExpression(),
                sourceId: archiveOperationSourceExpression(),
                recordType: {
                  $cond: [
                    { $in: ['$collection', archiveManifestCollections] },
                    '$collection',
                    'unknown',
                  ],
                },
              },
            },
            {
              $facet: {
                categories: [
                  {
                    $group: {
                      _id: { category: '$category', source: '$sourceId' },
                      operations: { $sum: 1 },
                      insertOperations: countMutation('insert'),
                      updateOperations: countMutation('update'),
                      deleteOperations: countMutation('delete'),
                      unknownImpactOperations: countMutation('unknown'),
                    },
                  },
                  {
                    $group: {
                      _id: '$_id.category',
                      operations: { $sum: '$operations' },
                      insertOperations: { $sum: '$insertOperations' },
                      updateOperations: { $sum: '$updateOperations' },
                      deleteOperations: { $sum: '$deleteOperations' },
                      unknownImpactOperations: { $sum: '$unknownImpactOperations' },
                      sourceCount: { $sum: { $cond: [{ $eq: ['$_id.source', null] }, 0, 1] } },
                      unknownSourceOperations: {
                        $sum: { $cond: [{ $eq: ['$_id.source', null] }, '$operations', 0] },
                      },
                    },
                  },
                ],
                recordTypes: [
                  {
                    $group: {
                      _id: { collection: '$recordType', source: '$sourceId' },
                      operations: { $sum: 1 },
                      insertOperations: countMutation('insert'),
                      updateOperations: countMutation('update'),
                      deleteOperations: countMutation('delete'),
                      unknownImpactOperations: countMutation('unknown'),
                    },
                  },
                  {
                    $group: {
                      _id: '$_id.collection',
                      operations: { $sum: '$operations' },
                      insertOperations: { $sum: '$insertOperations' },
                      updateOperations: { $sum: '$updateOperations' },
                      deleteOperations: { $sum: '$deleteOperations' },
                      unknownImpactOperations: { $sum: '$unknownImpactOperations' },
                      sourceCount: { $sum: { $cond: [{ $eq: ['$_id.source', null] }, 0, 1] } },
                      unknownSourceOperations: {
                        $sum: { $cond: [{ $eq: ['$_id.source', null] }, '$operations', 0] },
                      },
                    },
                  },
                ],
                targets: [
                  { $group: { _id: '$sourceId', operations: { $sum: 1 } } },
                  {
                    $group: {
                      _id: null,
                      distinctSources: { $sum: { $cond: [{ $eq: ['$_id', null] }, 0, 1] } },
                      unknownSourceOperations: {
                        $sum: { $cond: [{ $eq: ['$_id', null] }, '$operations', 0] },
                      },
                    },
                  },
                ],
              },
            },
          ],
          { maxTimeMS: MANIFEST_QUERY_TIMEOUT_MS, allowDiskUse: false },
        )
        .toArray();
      const rows = data[0]?.categories ?? [];
      const targetRow = data[0]?.targets[0];
      const targets = {
        distinctSources: targetRow?.distinctSources ?? 0,
        unknownSourceOperations: targetRow?.unknownSourceOperations ?? 0,
      };
      if (Object.values(targets).some((value) => !Number.isSafeInteger(value) || value < 0))
        return { status: 'unavailable', reason: 'invalid-data' };
      const categories: ArchiveManifestCategorySummary[] = [];
      const impacts = emptyManifestImpact();
      let totalOperations = 0;
      for (const category of archiveManifestCategories) {
        const row = rows.find((entry) => entry._id === category);
        if (row === undefined) continue;
        const counts = {
          operations: row.operations,
          insertOperations: row.insertOperations,
          updateOperations: row.updateOperations,
          deleteOperations: row.deleteOperations,
          unknownImpactOperations: row.unknownImpactOperations,
        };
        if (
          Object.values(counts).some((value) => !Number.isSafeInteger(value) || value < 0) ||
          counts.operations !==
            counts.insertOperations +
              counts.updateOperations +
              counts.deleteOperations +
              counts.unknownImpactOperations
        )
          return { status: 'unavailable', reason: 'invalid-data' };
        categories.push({
          category,
          ...counts,
          sourceCount: row.sourceCount,
          unknownSourceOperations: row.unknownSourceOperations,
        });
        totalOperations += counts.operations;
        impacts.insertOperations += counts.insertOperations;
        impacts.updateOperations += counts.updateOperations;
        impacts.deleteOperations += counts.deleteOperations;
        impacts.unknownImpactOperations += counts.unknownImpactOperations;
      }
      if (
        categories.length !== rows.length ||
        !Number.isSafeInteger(totalOperations) ||
        (run['operations'] !== undefined && run['operations'] !== totalOperations)
      )
        return { status: 'unavailable', reason: 'invalid-data' };
      const recordTypes = archiveManifestCollections.flatMap((collection) => {
        const row = data[0]?.recordTypes.find((entry) => entry._id === collection);
        return row === undefined
          ? []
          : [
              {
                collection,
                operations: row.operations,
                insertOperations: row.insertOperations,
                updateOperations: row.updateOperations,
                deleteOperations: row.deleteOperations,
                unknownImpactOperations: row.unknownImpactOperations,
                sourceCount: row.sourceCount,
                unknownSourceOperations: row.unknownSourceOperations,
              },
            ];
      });
      return { status: 'available', totalOperations, categories, impacts, targets, recordTypes };
    } catch (error: unknown) {
      return {
        status: 'unavailable',
        reason: record(error)['code'] === 50 ? 'timeout' : 'unavailable',
      };
    }
  }
  private async runState(
    run: RunDocument,
    summary: ArchiveManifestSummary,
    requestId?: string,
  ): Promise<{ actions: ArchiveConfirmedAction[]; verification?: ArchiveRunVerification }> {
    const scope = {
      guildId: this.guildId,
      $or: [{ runId: run._id }, { 'result.runId': run._id }],
    };
    const last = await this.jobsCollection()
      .find(
        { ...scope, command: { $in: ['apply', 'resume', 'verify'] } },
        { projection: { status: 1, createdAt: 1, finishedAt: 1, result: 1 } },
      )
      .sort({ createdAt: -1, jobId: -1 })
      .limit(1)
      .maxTimeMS(MANIFEST_QUERY_TIMEOUT_MS)
      .next();
    const verifiedAt = run['verifiedAt'];
    const persistedVerification =
      typeof verifiedAt === 'number' && Number.isFinite(verifiedAt) && verifiedAt >= 0;
    const lastResult = record(last?.result);
    const currentJob =
      last !== null &&
      (!persistedVerification ||
        Math.max(finite(last.createdAt), finite(last.finishedAt)) >= verifiedAt) &&
      !(last.status === 'complete' && lastResult['status'] === undefined && persistedVerification);
    let verification: ArchiveRunVerification | undefined;
    if (
      currentJob &&
      last !== null &&
      ['complete', 'partial', 'failed', 'cancelled'].includes(last.status)
    ) {
      const result = lastResult;
      const unresolved = record(result['counts'])['unresolvedEvidence'];
      verification = {
        status:
          last.status === 'complete' && result['status'] !== 'complete'
            ? 'partial'
            : (last.status as ArchiveRunVerification['status']),
        ...(last.finishedAt === undefined ? {} : { checkedAt: finite(last.finishedAt) }),
        ...(typeof unresolved === 'number' && Number.isSafeInteger(unresolved) && unresolved >= 0
          ? { unresolved }
          : {}),
        ...issueSummary([
          ...(Array.isArray(result['issues']) ? result['issues'] : []),
          ...(result['error'] === undefined ? [] : [result['error']]),
          ...(last.status === 'complete' && result['status'] !== 'complete'
            ? ['Missing complete verification result']
            : []),
        ]),
      };
    } else if (persistedVerification && ['complete', 'accepted'].includes(run.status)) {
      // The verifier persists completion only after all current checks succeed; job history is optional.
      verification = {
        status: 'complete',
        checkedAt: verifiedAt,
        unresolved: 0,
        issueCount: 0,
        issueCategories: [],
      };
    }
    const state = { ...(verification === undefined ? {} : { verification }) };
    if (summary.status !== 'available') return { actions: [], ...state };
    try {
      this.assertSettings(run);
    } catch {
      return { actions: [], ...state };
    }
    const active = await this.jobsCollection().findOne(
      {
        ...scope,
        status: { $in: ['queued', 'running'] },
        ...(requestId === undefined ? {} : { requestId: { $ne: requestId } }),
      },
      { projection: { _id: 1 }, maxTimeMS: MANIFEST_QUERY_TIMEOUT_MS },
    );
    if (active !== null) return { actions: [], ...state };
    const result = confirmedActions.filter((action) => this.eligible(action, run));
    if (!result.includes('accept')) return { actions: result, ...state };
    const coverage = record(run['coverage']);
    if (
      (run['coverage'] !== undefined && coverage['status'] !== 'complete') ||
      (verification !== undefined &&
        (verification.status !== 'complete' ||
          verification.issueCount > 0 ||
          (verification.unresolved !== undefined && verification.unresolved > 0)))
    )
      return { actions: result.filter((action) => action !== 'accept'), ...state };
    return { actions: result, ...state };
  }

  public async manifestSummary(runId: string): Promise<ArchiveManifestSummary> {
    return this.summarizeManifest(await this.run(runId));
  }
  private async manifestHash(run: RunDocument): Promise<string> {
    const { controlConsumers: _consumers, controlConsumerOwners: _owners, ...manifest } = run;
    const hash = createHash('sha256').update(mongo.BSON.serialize(manifest));
    const cursor = this.connection
      .collection('archive_repair_operations')
      .find(
        { runId: run._id },
        {
          projection: {
            ...archiveOperationProjection(digest(run.policyHash)),
            runId: 1,
            documentId: 1,
            dependencies: 1,
            beforeHash: 1,
            afterHash: 1,
            collection: 1,
            reason: 1,
            state: 1,
          },
        },
      )
      .sort({ sequence: 1, _id: 1 })
      .batchSize(100)
      .maxTimeMS(30_000);
    try {
      for await (const operation of cursor) hash.update(mongo.BSON.serialize(operation));
    } finally {
      await cursor.close();
    }
    return hash.digest('hex');
  }
  private async enqueue(
    command: ArchiveJob['command'],
    options: Record<string, unknown>,
    requestId: string,
    runId?: string,
    notification?: Notification,
  ): Promise<ArchiveJobSummary> {
    if (notification?.messageId !== undefined) {
      return withArchivePublicMessageLock(notification.channelId, notification.messageId, () =>
        this.storeJob(command, options, requestId, runId, notification),
      );
    }
    return this.storeJob(command, options, requestId, runId, notification);
  }
  private async storeJob(
    command: ArchiveJob['command'],
    options: Record<string, unknown>,
    requestId: string,
    runId?: string,
    notification?: Notification,
  ): Promise<ArchiveJobSummary> {
    reference.parse(requestId);
    if (notification !== undefined) notificationSchema.parse(notification);
    const jobId = `${this.guildId}:${requestId}`;
    if (
      await archiveJobDeletions(this.connection).findOne({
        _id: 'job:' + jobId,
        guildId: this.guildId,
      })
    )
      throw new Error('Archive job was deleted');
    if (runId !== undefined)
      await reserveArchiveRunConsumer(this.connection, this.guildId, runId, requestId);
    const job: ArchiveJob & { _id: string } = {
      _id: jobId,
      jobId,
      requestId,
      guildId: this.guildId,
      command,
      options,
      ...(runId === undefined ? {} : { runId }),
      ...(notification === undefined ? {} : { notification }),
      status: 'queued',
      cancelRequested: false,
      createdAt: Date.now(),
    };
    // The primary key and stable request token make concurrent button replays idempotent.
    try {
      await this.jobsCollection().updateOne(
        { _id: jobId },
        { $setOnInsert: job },
        { upsert: true },
      );
    } catch (error) {
      if (!(error instanceof mongo.MongoServerError && error.code === 11000)) throw error;
    }
    const stored = await this.jobsCollection().findOne({ _id: jobId, guildId: this.guildId });
    if (stored === null) throw new Error('Archive request persistence failed');
    const deleted = await archiveJobDeletions(this.connection).findOne({
      _id: 'job:' + jobId,
      guildId: this.guildId,
    });
    if (deleted !== null) {
      await this.jobsCollection().updateOne(
        { jobId, guildId: this.guildId },
        { $set: { cancelRequested: true, deleteRequestedAt: deleted.requestedAt } },
      );
      await finalizeArchiveJobDeletion(this.connection, this.guildId, jobId);
      throw new Error('Archive job was deleted');
    }
    if (!['queued', 'running'].includes(stored.status))
      await releaseArchiveRunConsumer(this.connection, stored.runId, stored.requestId);
    if (
      stored.command !== command ||
      stored.runId !== runId ||
      JSON.stringify(stored.options) !== JSON.stringify(options)
    )
      throw new Error('Request already identifies a different archive action');
    if (
      stored.notification?.messageId !== undefined &&
      stored.notification.supersededAt === undefined
    ) {
      await this.jobsCollection().updateMany(
        {
          guildId: this.guildId,
          jobId: { $ne: jobId },
          'notification.channelId': stored.notification.channelId,
          'notification.messageId': stored.notification.messageId,
          'notification.supersededAt': { $exists: false },
        },
        { $set: { 'notification.supersededAt': Date.now() } },
      );
    }
    return safeArchiveJobSummary(stored);
  }
  public async submit(
    command: 'audit' | 'plan' | 'verify' | 'refresh-attachment',
    options: SubmitOptions = {},
  ): Promise<ArchiveJobSummary> {
    z.enum(['audit', 'plan', 'verify', 'refresh-attachment']).parse(command);
    const parsed = z
      .object({
        runId: reference.optional(),
        channelId: id.optional(),
        messageId: id.optional(),
        attachmentId: id.optional(),
        userId: id.optional(),
        notification: notificationSchema.optional(),
      })
      .strict()
      .parse(options);
    if (command === 'verify') {
      if (parsed.runId === undefined) throw new Error('Repair run is required');
      const run = await this.run(parsed.runId);
      this.assertSettings(run);
      if (!this.eligible('verify', run))
        throw new Error('Repair run is not eligible for verification');
    } else if (parsed.runId !== undefined)
      throw new Error('This command does not accept a repair run');
    const payload: Record<string, unknown> = {};
    if (command === 'refresh-attachment') {
      for (const field of ['channelId', 'messageId', 'attachmentId', 'userId'] as const) {
        const value = parsed[field];
        if (value === undefined) throw new Error('Attachment refresh scope is required');
        payload[field] = value;
      }
    } else if (
      parsed.channelId !== undefined ||
      parsed.messageId !== undefined ||
      parsed.attachmentId !== undefined ||
      parsed.userId !== undefined
    )
      throw new Error('This command does not accept attachment scope');
    return this.enqueue(command, payload, randomUUID(), parsed.runId, parsed.notification);
  }
  public async status(jobId: string): Promise<ArchiveJobSummary> {
    reference.parse(jobId);
    const job = await this.jobsCollection().findOne({ jobId, guildId: this.guildId });
    if (job === null) throw new Error('Unknown archive job for this guild');
    return { ...safeArchiveJobSummary(job), progress: archiveJobProgress(job) };
  }
  public async cancel(jobId: string): Promise<ArchiveJobSummary> {
    reference.parse(jobId);
    await this.jobsCollection().updateOne(
      { jobId, guildId: this.guildId, status: { $in: ['queued', 'running'] } },
      [
        {
          $set: {
            cancelRequested: true,
            status: { $cond: [{ $eq: ['$status', 'queued'] }, 'cancelled', '$status'] },
            finishedAt: { $cond: [{ $eq: ['$status', 'queued'] }, Date.now(), '$finishedAt'] },
          },
        },
      ],
    );
    const stopped = await this.status(jobId);
    if (stopped.status !== 'running')
      await releaseArchiveRunConsumer(this.connection, stopped.runId, stopped.requestId);
    return stopped;
  }
  public async stop(jobId: string): Promise<ArchiveJobSummary> {
    return this.cancel(jobId);
  }
  public async deleteJob(
    jobId: string,
  ): Promise<{ jobId: string; deleted: boolean; pending: boolean; notification?: Notification }> {
    reference.parse(jobId);
    const job = await this.jobsCollection().findOne({ jobId, guildId: this.guildId });
    const receipts = archiveJobDeletions(this.connection);
    const previous = await receipts.findOne({ _id: 'job:' + jobId, guildId: this.guildId });
    if (job === null && previous === null) throw new Error('Unknown archive job for this guild');
    if (job !== null) {
      await receipts.updateOne(
        { _id: 'job:' + jobId, guildId: this.guildId },
        {
          $setOnInsert: {
            _id: 'job:' + jobId,
            guildId: this.guildId,
            jobId,
            requestId: job.requestId,
            ...(job.runId === undefined ? {} : { runId: job.runId }),
            requestedAt: Date.now(),
            ...(job.notification === undefined ? {} : { notification: job.notification }),
          },
        },
        { upsert: true },
      );
      await this.jobsCollection().updateOne(
        { jobId, guildId: this.guildId },
        { $set: { cancelRequested: true, deleteRequestedAt: previous?.requestedAt ?? Date.now() } },
      );
      await this.confirmations().updateMany(
        { guildId: this.guildId, requestId: job.requestId },
        { $set: { purgedAt: Date.now() } },
      );
    }
    const deleted = await finalizeArchiveJobDeletion(this.connection, this.guildId, jobId);
    const notification = job?.notification ?? previous?.notification;
    return {
      jobId,
      deleted,
      pending: !deleted,
      ...(notification === undefined ? {} : { notification }),
    };
  }
  private async planDeletable(run: RunDocument): Promise<boolean> {
    if (
      !deletablePlanStatuses.includes(run.status) ||
      run['deleteRequestedAt'] !== undefined ||
      (Array.isArray(run['controlConsumers']) && run['controlConsumers'].length > 0)
    )
      return false;
    const rolledBack = run.status === 'rolled-back';
    const [active, applied, journal, conflict] = await Promise.all([
      this.jobsCollection().findOne(
        {
          guildId: this.guildId,
          status: { $in: ['queued', 'running'] },
          $or: [
            { runId: run._id },
            { 'result.runId': run._id },
            ...(typeof run['originatingJobId'] === 'string'
              ? [{ jobId: run['originatingJobId'] }]
              : []),
          ],
        },
        { projection: { _id: 1 } },
      ),
      this.connection.collection('archive_repair_operations').findOne(
        {
          runId: run._id,
          // Unexecuted operations need no rollback; all mutations must have been restored.
          state: { $nin: rolledBack ? ['planned', 'rolled-back'] : ['planned'] },
        },
        { projection: { _id: 1 } },
      ),
      this.connection
        .collection('archive_journals')
        .findOne({ runId: run._id }, { projection: { _id: 1 } }),
      rolledBack
        ? this.connection
            .collection('archive_repair_conflicts')
            .findOne({ runId: run._id }, { projection: { _id: 1 } })
        : Promise.resolve(null),
    ]);
    return active === null && applied === null && journal === null && conflict === null;
  }
  public async canDeletePlan(runId: string): Promise<boolean> {
    reference.parse(runId);
    const run = await this.connection
      .collection<RunDocument>('archive_repair_runs')
      .findOne({ _id: runId, guildId: this.guildId });
    return run !== null && (await this.planDeletable(run));
  }
  public async plans(
    options: { before?: string; limit?: number } = {},
  ): Promise<{ plans: ArchiveRunSummary[]; nextCursor?: string }> {
    z.object({ before: reference.optional(), limit: z.number().int().min(1).max(10).optional() })
      .strict()
      .parse(options);
    const runs = this.connection.collection<RunDocument>('archive_repair_runs');
    const filter: Record<string, unknown> = {
      guildId: this.guildId,
      deleteRequestedAt: { $exists: false },
    };
    if (options.before !== undefined) {
      const anchor = await this.run(options.before);
      filter['$or'] = [
        { createdAt: { $lt: anchor['createdAt'] } },
        { createdAt: anchor['createdAt'], _id: { $lt: anchor._id } },
      ];
    }
    const limit = options.limit ?? 10;
    const rows = await runs
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .maxTimeMS(MANIFEST_QUERY_TIMEOUT_MS)
      .toArray();
    const page = rows.slice(0, limit);
    return {
      plans: await Promise.all(
        page.map(async (run) => ({ ...runSummary(run), deletable: await this.planDeletable(run) })),
      ),
      ...(rows.length > limit ? { nextCursor: page.at(-1)!._id } : {}),
    };
  }
  public async deletePlan(runId: string): Promise<{ runId: string; deleted: boolean }> {
    reference.parse(runId);
    const runs = this.connection.collection<RunDocument>('archive_repair_runs');
    const run = await runs.findOne({ _id: runId, guildId: this.guildId });
    const receipts = this.connection.collection<{
      _id: string;
      guildId: string;
      deletedAt?: number;
    }>('archive_plan_deletions');
    if (run === null) {
      if (await receipts.findOne({ _id: runId, guildId: this.guildId }))
        return { runId, deleted: true };
      throw new Error('Unknown repair manifest for this guild');
    }
    if (run['deleteRequestedAt'] === undefined) {
      if (!deletablePlanStatuses.includes(run.status))
        throw new Error('Applied repair recovery cannot be deleted');
      const reserved = await runs.updateOne(
        {
          _id: runId,
          guildId: this.guildId,
          status: run.status,
          deleteRequestedAt: { $exists: false },
          $or: [{ controlConsumers: { $exists: false } }, { controlConsumers: { $size: 0 } }],
        },
        { $set: { deleteRequestedAt: Date.now() } },
      );
      if (reserved.matchedCount !== 1)
        throw new Error('Repair plan cannot be deleted while work is active');
    }
    // Holding the marker excludes new consumers; existing queued/running work must drain first.
    const marked = { ...run };
    delete marked['deleteRequestedAt'];
    if (!(await this.planDeletable(marked))) {
      await runs.updateOne(
        { _id: runId, guildId: this.guildId, deleteValidatedAt: { $exists: false } },
        { $unset: { deleteRequestedAt: '' } },
      );
      throw new Error('Repair plan cannot be deleted while work is active');
    }
    const validated = await runs.updateOne(
      { _id: runId, guildId: this.guildId, deleteRequestedAt: { $exists: true } },
      { $set: { deleteValidatedAt: Date.now() } },
    );
    if (validated.matchedCount !== 1) {
      if (
        (await runs.findOne({ _id: runId, guildId: this.guildId })) === null &&
        (await receipts.findOne({ _id: runId, guildId: this.guildId })) !== null
      )
        return { runId, deleted: true };
      throw new Error('Repair plan cannot be deleted while work is active');
    }
    await receipts.updateOne(
      { _id: runId, guildId: this.guildId },
      { $setOnInsert: { _id: runId, guildId: this.guildId } },
      { upsert: true },
    );
    await this.confirmations().updateMany(
      { guildId: this.guildId, runId },
      { $set: { purgedAt: Date.now() } },
    );
    await this.jobsCollection().updateMany(
      { guildId: this.guildId, $or: [{ runId }, { 'result.runId': runId }] },
      { $set: { 'notification.supersededAt': Date.now() } },
    );
    await this.connection.collection('archive_repair_operations').deleteMany({ runId });
    await this.connection
      .collection('archive_progress_details')
      .deleteMany({ guildId: this.guildId, runId });
    await runs.deleteOne({
      _id: runId,
      guildId: this.guildId,
      deleteRequestedAt: { $exists: true },
    });
    await receipts.updateOne(
      { _id: runId, guildId: this.guildId },
      { $set: { deletedAt: Date.now() } },
    );
    return { runId, deleted: true };
  }
  public async purgeJobs(): Promise<{ deleted: number; running: number }> {
    const statuses: ArchiveJob['status'][] = [
      'queued',
      'complete',
      'partial',
      'failed',
      'cancelled',
    ];
    const jobs = this.jobsCollection();
    const cursor = jobs
      .find(
        { guildId: this.guildId, status: { $in: statuses } },
        { projection: { jobId: 1, requestId: 1, runId: 1 } },
      )
      .batchSize(500);
    let deleted = 0;
    let batch: { jobId: string; requestId: string; runId?: string }[] = [];
    const purge = async (): Promise<void> => {
      if (batch.length === 0) return;
      // Keep approval receipts so old buttons cannot recreate deleted requests.
      await this.confirmations().updateMany(
        { guildId: this.guildId, requestId: { $in: batch.map((job) => job.requestId) } },
        { $set: { purgedAt: Date.now() } },
      );
      const result = await jobs.deleteMany({
        guildId: this.guildId,
        jobId: { $in: batch.map((job) => job.jobId) },
        status: { $in: statuses },
      });
      deleted += result.deletedCount;
      for (const job of batch) {
        if ((await jobs.findOne({ jobId: job.jobId, guildId: this.guildId })) === null)
          await releaseArchiveRunConsumer(this.connection, job.runId, job.requestId);
      }
      batch = [];
    };
    try {
      for await (const job of cursor) {
        batch.push({
          jobId: job.jobId,
          requestId: job.requestId,
          ...(job.runId === undefined ? {} : { runId: job.runId }),
        });
        if (batch.length === 500) await purge();
      }
      await purge();
    } finally {
      await cursor.close();
    }
    return {
      deleted,
      running: await jobs.countDocuments({ guildId: this.guildId, status: 'running' }),
    };
  }
  public async jobs(options: { all?: boolean; before?: string; limit?: number } = {}): Promise<{
    jobs: ArchiveJobSummary[];
    nextCursor?: string;
  }> {
    z.object({
      all: z.boolean().optional(),
      before: reference.optional(),
      limit: z.number().int().min(1).max(25).optional(),
    })
      .strict()
      .parse(options);
    const limit = pageLimit(options.limit, 25);
    const filter: Record<string, unknown> = {
      guildId: this.guildId,
      ...(options.all === true ? {} : { status: { $in: ['queued', 'running'] } }),
    };
    if (options.before !== undefined) {
      reference.parse(options.before);
      const anchor = await this.jobsCollection().findOne({
        jobId: options.before,
        guildId: this.guildId,
      });
      if (anchor === null) throw new Error('Unknown archive pagination cursor');
      filter['$or'] = [
        { createdAt: { $lt: anchor.createdAt } },
        { createdAt: anchor.createdAt, jobId: { $lt: anchor.jobId } },
      ];
    }
    const jobs = await this.jobsCollection()
      .find(filter)
      .sort({ createdAt: -1, jobId: -1 })
      .limit(limit + 1)
      .toArray();
    const page = jobs.slice(0, limit);
    const last = page.at(-1);
    return {
      jobs: page.map(safeArchiveJobSummary),
      ...(jobs.length > limit && last !== undefined ? { nextCursor: last.jobId } : {}),
    };
  }
  public async manifest(
    runId: string,
    options: {
      afterSequence?: number;
      beforeSequence?: number;
      category?: ArchiveManifestCategory;
      group?: ArchiveManifestGroupFilter;
      sourceId?: string;
      limit?: number;
    } = {},
  ): Promise<{
    run: ArchiveRunSummary;
    summary: ArchiveManifestSummary;
    operations: ArchiveOperationSummary[];
    nextSequence: number;
    hasNext: boolean;
    hasPrevious: boolean;
    nextCursor?: number;
    previousCursor?: number;
  }> {
    z.object({
      afterSequence: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).optional(),
      beforeSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      category: z.enum(archiveManifestCategories).optional(),
      group: archiveManifestGroupSchema.optional(),
      sourceId: archiveManifestSourceSchema.optional(),
      limit: z.number().int().min(1).max(100).optional(),
    })
      .strict()
      .parse(options);
    if (options.afterSequence !== undefined && options.beforeSequence !== undefined)
      throw new Error('Archive pagination accepts one direction at a time');
    const run = await this.run(runId);
    const after = options.afterSequence ?? -1;
    const filter = {
      runId,
      ...archiveManifestFilter(options),
    };
    const limit = pageLimit(options.limit, 100);
    const collection = this.connection.collection<Record<string, unknown> & { _id: string }>(
      'archive_repair_operations',
    );
    const rows = await collection
      .find(
        {
          ...filter,
          sequence:
            options.beforeSequence === undefined ? { $gt: after } : { $lt: options.beforeSequence },
        },
        {
          projection: archiveOperationProjection(digest(run.policyHash)),
        },
      )
      .sort({ sequence: options.beforeSequence === undefined ? 1 : -1 })
      .limit(limit + 1)
      .maxTimeMS(MANIFEST_QUERY_TIMEOUT_MS)
      .toArray();
    const operations = rows.slice(0, limit);
    if (options.beforeSequence !== undefined) operations.reverse();
    const safe = operations.map(
      (operation): ArchiveOperationSummary => ({
        operationId: safeReference(operation._id) ?? 'unknown',
        ...(scalarDocumentId(operation['documentId']) === undefined
          ? {}
          : { documentId: scalarDocumentId(operation['documentId']) }),
        sequence: finite(operation['sequence']),
        collection: safeReference(operation['collection']) ?? 'unknown',
        state: safeReference(operation['state']) ?? 'unknown',
        reason: safeReference(operation['reason']) ?? 'other',
        category: archiveManifestCategory(operation['collection'], operation['reason']),
        target: safeArchiveOperationTarget(operation),
        changes: safeArchiveOperationChanges(
          operation,
          archiveManifestCategory(operation['collection'], operation['reason']),
        ),
        ...([
          'bot-not-allowlisted',
          'webhook-not-allowlisted',
          'rule-exclude',
          'guild-out-of-scope',
        ].includes(String(operation['policyReason']))
          ? { policyReason: operation['policyReason'] as ArchiveOperationSummary['policyReason'] }
          : {}),
        ...(safeReference(operation['policyRuleId']) === undefined
          ? {}
          : { policyRuleId: safeReference(operation['policyRuleId']) }),
        ...(operation['collection'] === 'archive_quarantine' &&
        safeReference(operation['quarantineReason']) !== undefined
          ? { quarantineReason: safeReference(operation['quarantineReason']) }
          : {}),
        impact:
          operation['impact'] === 'insert' ||
          operation['impact'] === 'update' ||
          operation['impact'] === 'delete'
            ? operation['impact']
            : 'unknown',
        dependencies: Array.isArray(operation['dependencies'])
          ? operation['dependencies']
              .flatMap((value: unknown) => safeReference(value) ?? [])
              .slice(0, 100)
          : [],
        beforeHash:
          typeof operation['beforeHash'] === 'string' &&
          /^[a-f0-9]{64}$/.test(operation['beforeHash'])
            ? operation['beforeHash']
            : '',
        afterHash:
          typeof operation['afterHash'] === 'string' &&
          /^[a-f0-9]{64}$/.test(operation['afterHash'])
            ? operation['afterHash']
            : '',
      }),
    );
    const first = safe.at(0)?.sequence;
    const last = safe.at(-1)?.sequence;
    const previous =
      first === undefined
        ? null
        : await collection.findOne(
            { ...filter, sequence: { $lt: first } },
            { projection: { _id: 1 }, maxTimeMS: MANIFEST_QUERY_TIMEOUT_MS },
          );
    const next =
      last === undefined
        ? null
        : await collection.findOne(
            { ...filter, sequence: { $gt: last } },
            { projection: { _id: 1 }, maxTimeMS: MANIFEST_QUERY_TIMEOUT_MS },
          );
    const summary = await this.summarizeManifest(run);
    const state = await this.runState(run, summary);
    return {
      run: {
        ...runSummary(run, state.actions, state.verification),
        deletable: await this.planDeletable(run),
      },
      summary,
      operations: safe,
      nextSequence: last ?? after,
      hasNext: next !== null,
      hasPrevious: previous !== null,
      ...(next === null || last === undefined ? {} : { nextCursor: last }),
      ...(previous === null || first === undefined ? {} : { previousCursor: first }),
    };
  }
  public async manifestGroups(
    runId: string,
    options: {
      category?: ArchiveManifestCategory;
      afterGroup?: string;
      beforeGroup?: string;
      limit?: number;
    } = {},
  ): Promise<ArchiveManifestPage<ArchiveManifestGroup, 'groups'>> {
    const cursor = z
      .string()
      .regex(/^[A-Za-z0-9:_-]{1,160}\|[A-Za-z0-9:_-]{1,160}\|(?:insert|update|delete|unknown)$/);
    z.object({
      category: z.enum(archiveManifestCategories).optional(),
      afterGroup: cursor.optional(),
      beforeGroup: cursor.optional(),
      limit: z.number().int().min(1).max(25).optional(),
    })
      .strict()
      .parse(options);
    if (options.afterGroup !== undefined && options.beforeGroup !== undefined)
      throw new Error('Archive pagination accepts one direction at a time');
    await this.run(runId);
    return new ArchiveManifestQueries(this.connection).groups(runId, options, {
      after: options.afterGroup,
      before: options.beforeGroup,
      limit: pageLimit(options.limit, 25),
    });
  }
  public async manifestSources(
    runId: string,
    options: {
      category?: ArchiveManifestCategory;
      group?: ArchiveManifestGroupFilter;
      afterSource?: string;
      beforeSource?: string;
      limit?: number;
    } = {},
  ): Promise<ArchiveManifestPage<ArchiveManifestSource, 'sources'>> {
    z.object({
      category: z.enum(archiveManifestCategories).optional(),
      group: archiveManifestGroupSchema.optional(),
      afterSource: archiveManifestSourceSchema.optional(),
      beforeSource: archiveManifestSourceSchema.optional(),
      limit: z.number().int().min(1).max(25).optional(),
    })
      .strict()
      .parse(options);
    if (options.afterSource !== undefined && options.beforeSource !== undefined)
      throw new Error('Archive pagination accepts one direction at a time');
    await this.run(runId);
    return new ArchiveManifestQueries(this.connection).sources(runId, options, {
      after: options.afterSource,
      before: options.beforeSource,
      limit: pageLimit(options.limit, 25),
    });
  }
  public async operation(
    runId: string,
    sequence: number,
  ): Promise<{ run: ArchiveRunSummary; operation: ArchiveOperationSummary }> {
    z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(sequence);
    const page = await this.manifest(runId, { afterSequence: sequence - 1, limit: 1 });
    const operation = page.operations[0];
    if (operation === undefined || operation.sequence !== sequence)
      throw new Error('Unknown archive operation for this manifest');
    const collection = this.connection.collection<Record<string, unknown> & { _id: string }>(
      'archive_repair_operations',
    );
    let direct: (Record<string, unknown> & { _id: string })[] = [];
    let dependenciesAvailable = true;
    try {
      direct =
        operation.dependencies.length === 0
          ? []
          : await collection
              .find(
                { runId, _id: { $in: operation.dependencies } },
                { projection: archiveOperationProjection(page.run.policyHash) },
              )
              .limit(100)
              .maxTimeMS(MANIFEST_QUERY_TIMEOUT_MS)
              .toArray();
    } catch {
      dependenciesAvailable = false;
    }
    const safeSequence = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    operation.dependencyReferences = operation.dependencies.map((operationId) => {
      const dependency = direct.find((row) => row._id === operationId);
      const knownSequence = safeSequence(dependency?.['sequence']);
      return !dependenciesAvailable
        ? { operationId, state: 'unavailable' }
        : dependency === undefined || knownSequence === undefined
          ? { operationId, state: 'missing' }
          : {
              operationId,
              state: 'known',
              sequence: knownSequence,
              executionState: safeReference(dependency['state']) ?? 'unknown',
            };
    });
    operation.dependencyReferencesComplete = false;
    try {
      const projected = await collection.findOne(
        { runId, sequence },
        {
          projection: {
            dependencyCount: {
              $cond: [{ $isArray: '$dependencies' }, { $size: '$dependencies' }, 0],
            },
          },
          maxTimeMS: MANIFEST_QUERY_TIMEOUT_MS,
        },
      );
      operation.dependencyReferencesComplete =
        dependenciesAvailable && projected?.['dependencyCount'] === operation.dependencies.length;
    } catch {
      operation.dependencyReferencesComplete = false;
    }
    operation.survivorStatus = ['delete-duplicate-cursor', 'delete-verified-duplicate'].includes(
      operation.reason,
    )
      ? 'unavailable'
      : 'not-applicable';
    if (
      operation.survivorStatus === 'unavailable' &&
      operation.target.channelId !== undefined &&
      operation.impact === 'delete'
    ) {
      const matched = direct.filter((row) => {
        const target = safeArchiveOperationTarget(row);
        return (
          row['collection'] === operation.collection &&
          target.channelId === operation.target.channelId &&
          (operation.collection !== 'messages' ||
            (operation.target.messageId !== undefined &&
              target.messageId === operation.target.messageId)) &&
          scalarDocumentId(row['documentId']) !== operation.documentId &&
          row['impact'] === 'update' &&
          ['reset-cursor-for-full-reconciliation', 'merge-compatible-duplicate'].includes(
            String(row['reason']),
          )
        );
      });
      const dependency = matched.length === 1 ? matched[0] : undefined;
      const documentId = scalarDocumentId(dependency?.['documentId']);
      const dependencySequence = safeSequence(dependency?.['sequence']);
      if (
        dependency !== undefined &&
        documentId !== undefined &&
        dependencySequence !== undefined &&
        dependencySequence < sequence
      ) {
        operation.survivor = {
          documentId,
          operationId: safeReference(dependency._id),
          sequence: dependencySequence,
          evidence: 'dependency',
        };
        operation.survivorStatus = 'verified';
      } else {
        const retained = await this.retainedOperationRecord(runId, operation).catch(
          () => undefined,
        );
        if (retained !== undefined) {
          operation.survivor = { documentId: retained, evidence: 'retained-record' };
          operation.survivorStatus = 'verified';
        }
      }
    }
    if (
      ['relocate-to-quarantine', 'quarantine-invalid-cursor'].includes(operation.reason) &&
      operation.impact === 'delete' &&
      operation.documentId !== undefined &&
      operation.dependencyReferencesComplete
    ) {
      const evidence = direct.filter((row) => {
        const target = safeArchiveOperationTarget(row);
        const sequence = safeSequence(row['sequence']);
        return (
          row['collection'] === 'archive_quarantine' &&
          row['impact'] === 'insert' &&
          row['reason'] === 'preserve-quarantine-evidence' &&
          row['quarantineSourceCollection'] === operation.collection &&
          scalarDocumentId(row['quarantineSourceDocumentId']) === operation.documentId &&
          scalarDocumentId(row['quarantineSnapshotDocumentId']) === operation.documentId &&
          sequence !== undefined &&
          sequence < operation.sequence &&
          (operation.collection !== 'messages' ||
            (operation.target.channelId !== undefined &&
              target.channelId === operation.target.channelId &&
              operation.target.messageId !== undefined &&
              target.messageId === operation.target.messageId))
        );
      });
      const reason =
        evidence.length === 1 ? safeReference(evidence[0]?.['quarantineReason']) : undefined;
      if (reason !== undefined && reason !== 'unknown') operation.quarantineReason = reason;
    }
    return { run: page.run, operation };
  }
  private async retainedOperationRecord(
    runId: string,
    operation: ArchiveOperationSummary,
  ): Promise<string | undefined> {
    if (!['fetches', 'messages'].includes(operation.collection)) return undefined;
    const source = operation.target.channelId;
    const message = operation.target.messageId;
    if (source === undefined || (operation.collection === 'messages' && message === undefined))
      return undefined;
    const records = await this.connection
      .collection(operation.collection)
      .aggregate<Record<string, unknown>>(
        [
          {
            $match:
              operation.collection === 'fetches'
                ? { channelID: source }
                : { channelId: source, messageId: message },
          },
          { $project: { _id: 1 } },
          {
            $lookup: {
              from: 'archive_repair_operations',
              let: { retainedId: '$_id' },
              pipeline: [
                {
                  $match: {
                    runId,
                    collection: operation.collection,
                    $expr: { $eq: ['$documentId', '$$retainedId'] },
                  },
                },
                {
                  $match: {
                    $expr: { $in: [archiveOperationImpactExpression(), ['delete', 'unknown']] },
                  },
                },
                { $project: { _id: 1 } },
                { $limit: 1 },
              ],
              as: 'removals',
            },
          },
          { $match: { removals: { $size: 0 } } },
          { $project: { _id: 1 } },
          { $limit: 2 },
        ],
        { maxTimeMS: MANIFEST_QUERY_TIMEOUT_MS, allowDiskUse: false },
      )
      .toArray();
    return records.length === 1 ? scalarDocumentId(records[0]?.['_id']) : undefined;
  }
  public async periodicStatus(): Promise<Record<string, unknown> | null> {
    const state = await this.connection
      .collection<Record<string, unknown> & { _id: string }>('archive_periodic_runs')
      .findOne({ _id: 'current' });
    if (state === null) return null;
    const result = record(state['result']);
    const progress = progressSummary(
      state['progress'] ?? result['progress'] ?? record(result['details'])['progress'],
    );
    return {
      guildId: this.guildId,
      runId: safeReference(state['runId']) ?? 'unknown',
      status: safeReference(state['status']) ?? 'unknown',
      cutoff: finite(state['cutoff']),
      full: state['full'] === true,
      ...(progress === undefined ? {} : { progress }),
      counts: safeCounts(result['counts']),
      ...issueSummary(result['issues']),
    };
  }
  public async progressDetails(
    scopeId: string,
    page = 1,
    limit = 3,
  ): Promise<{
    activities: ArchiveProgressSnapshot['activities'];
    gaps: ArchiveScopeGap[];
    page: number;
    hasNext: boolean;
  }> {
    reference.parse(scopeId);
    z.number().int().min(1).max(100000).parse(page);
    z.number().int().min(1).max(3).parse(limit);
    const rows = await this.connection
      .collection('archive_progress_details')
      .aggregate<Record<string, unknown>>(
        [
          { $match: { guildId: this.guildId, scopeId } },
          {
            $project: {
              sourceId: 1,
              entries: {
                $concatArrays: [
                  {
                    $cond: [
                      { $eq: [{ $type: '$activity' }, 'object'] },
                      [
                        {
                          kind: 'activity',
                          value: {
                            sourceId: '$activity.sourceId',
                            name: '$activity.name',
                            step: '$activity.step',
                            scanned: '$activity.scanned',
                            cursor: '$activity.cursor',
                            retryAt: '$activity.retryAt',
                            provisional: '$activity.provisional',
                            pageProcessed: '$activity.pageProcessed',
                            pageTotal: '$activity.pageTotal',
                          },
                        },
                      ],
                      [],
                    ],
                  },
                  {
                    $map: {
                      input: { $cond: [{ $isArray: '$gaps' }, '$gaps', []] },
                      as: 'gap',
                      in: {
                        kind: 'gap',
                        value: {
                          sourceId: '$$gap.sourceId',
                          name: '$$gap.name',
                          reason: '$$gap.reason',
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
          { $unwind: { path: '$entries', includeArrayIndex: 'entryIndex' } },
          { $sort: { sourceId: 1, _id: 1, entryIndex: 1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit + 1 },
          { $project: { _id: 0, entry: '$entries' } },
        ],
        { maxTimeMS: MANIFEST_QUERY_TIMEOUT_MS, allowDiskUse: false },
      )
      .toArray();
    const activities: ArchiveProgressSnapshot['activities'] = [];
    const gaps: ArchiveScopeGap[] = [];
    for (const row of rows.slice(0, limit)) {
      const entry = record(row['entry']);
      const safe = sanitizeArchiveProgress({
        phase: 'history',
        state: 'running',
        activities: entry['kind'] === 'activity' ? [entry['value']] : [],
        gaps: entry['kind'] === 'gap' ? [entry['value']] : [],
      });
      activities.push(...(safe?.activities ?? []));
      gaps.push(...(safe?.gaps ?? []).map((gap) => ({ ...gap, name: safeArchiveName(gap.name) })));
    }
    return {
      activities,
      gaps,
      page,
      hasNext: rows.length > limit,
    };
  }

  public async autocomplete(
    kind: 'job' | 'run',
    query: string,
    action?: ArchiveConfirmedAction | 'verify' | 'cancel',
  ): Promise<
    { name: string; value: string; command?: string; status: string; createdAt: number }[]
  > {
    z.enum(['job', 'run']).parse(kind);
    z.string().max(160).parse(query);
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (kind === 'job') {
      const jobs = await this.jobsCollection()
        .find({
          guildId: this.guildId,
          jobId: { $regex: escaped },
          ...(action === undefined ? {} : { status: { $in: ['queued', 'running'] } }),
        })
        .sort({ createdAt: -1 })
        .limit(25)
        .toArray();
      return jobs.map((job) => ({
        name: `${job.command} ${job.status} ${job.jobId}`.slice(0, 100),
        value: job.jobId,
        command: safeReference(job.command) ?? 'unknown',
        status: safeReference(job.status) ?? 'unknown',
        createdAt: finite(job.createdAt),
      }));
    }
    const eligibleStatuses: Record<ArchiveConfirmedAction | 'verify', string[]> = {
      apply: ['planned', 'partial-plan'],
      resume: ['applying', 'enriching', 'verifying', 'partial'],
      rollback: [
        'applying',
        'enriching',
        'verifying',
        'complete',
        'partial',
        'accepted',
        'rolling-back',
        'rollback-conflicts',
      ],
      accept: ['complete'],
      verify: [
        'planned',
        'partial-plan',
        'applying',
        'enriching',
        'verifying',
        'complete',
        'partial',
        'accepted',
        'rolling-back',
        'rollback-conflicts',
      ],
    };
    if (action === 'cancel') return [];
    const runs = await this.connection
      .collection<RunDocument>('archive_repair_runs')
      .find({
        guildId: this.guildId,
        _id: { $regex: escaped },
        ...(action === undefined
          ? {}
          : {
              status: { $in: eligibleStatuses[action] },
              $and: [
                {
                  $or: [
                    {
                      journalVersion: 2,
                      schemaHash: `${this.settings.schemaHash ?? 'archive-v2'}:journal-v2`,
                    },
                    {
                      journalVersion: { $in: [null, 1] },
                      schemaHash: this.settings.schemaHash ?? 'archive-v2',
                    },
                  ],
                },
              ],
              ...(this.settings.policyHash === undefined
                ? {}
                : { policyHash: this.settings.policyHash() }),
              ...(action === 'apply'
                ? { $or: [{ validUntil: { $gt: Date.now() } }, { validUntil: { $exists: false } }] }
                : {}),
            }),
      })
      .sort({ createdAt: -1 })
      .limit(25)
      .toArray();
    return runs.map((run) => ({
      name: `${safeReference(run.status) ?? 'unknown'} ${run._id}`.slice(0, 100),
      value: reference.parse(run._id),
      status: safeReference(run.status) ?? 'unknown',
      createdAt: finite(run['createdAt']),
    }));
  }

  public async requestConfirmation(
    action: ArchiveConfirmedAction,
    runId: string,
    actor: Actor,
  ): Promise<{
    token: string;
    action: ArchiveConfirmedAction;
    run: ArchiveRunSummary;
    summary: ArchiveManifestSummary;
    expiresAt: number;
  }> {
    z.enum(confirmedActions).parse(action);
    id.parse(actor.userId);
    id.parse(actor.channelId);
    const run = await this.run(runId);
    this.assertSettings(run);
    if (!this.eligible(action, run)) throw new Error('Repair run is not eligible for this action');
    const manifestHash = await this.manifestHash(run);
    const summary = await this.summarizeManifest(run);
    if (summary.status !== 'available')
      throw new Error('Archive manifest summary unavailable; inspect the run again');
    const current = await this.run(runId);
    if ((await this.manifestHash(current)) !== manifestHash)
      throw new Error('Repair manifest changed; request confirmation again');
    const state = await this.runState(current, summary);
    if (!state.actions.includes(action))
      throw new Error('Repair run is not eligible for this action');
    const token = randomBytes(18).toString('base64url');
    const expiresAt = Date.now() + 5 * 60_000;
    await this.confirmations().insertOne({
      _id: token,
      guildId: this.guildId,
      userId: actor.userId,
      channelId: actor.channelId,
      action,
      runId,
      manifestHash,
      requestId: randomUUID(),
      createdAt: Date.now(),
      expiresAt,
    });
    return {
      token,
      action,
      run: runSummary(current, state.actions, state.verification),
      summary,
      expiresAt,
    };
  }
  public async validateConfirmation(token: string, actor: Actor): Promise<void> {
    z.string()
      .regex(/^[A-Za-z0-9_-]{24}$/)
      .parse(token);
    id.parse(actor.userId);
    id.parse(actor.channelId);
    const confirmation = await this.confirmations().findOne({
      _id: token,
      guildId: this.guildId,
      userId: actor.userId,
      channelId: actor.channelId,
    });
    if (confirmation === null) throw new Error('Unknown archive confirmation for this actor');
    if (confirmation.purgedAt !== undefined) throw new Error('Archive confirmation expired');
    if (confirmation.consumedAt === undefined && confirmation.expiresAt <= Date.now())
      throw new Error('Archive confirmation expired');
  }
  public async confirm(
    token: string,
    actor: Actor,
    notification?: Notification,
  ): Promise<ArchiveJobSummary> {
    z.string()
      .regex(/^[A-Za-z0-9_-]{24}$/)
      .parse(token);
    id.parse(actor.userId);
    id.parse(actor.channelId);
    if (notification !== undefined) notificationSchema.parse(notification);
    const filter = {
      _id: token,
      guildId: this.guildId,
      userId: actor.userId,
      channelId: actor.channelId,
    };
    const confirmation = await this.confirmations().findOne(filter);
    if (confirmation === null) throw new Error('Unknown archive confirmation for this actor');
    if (confirmation.purgedAt !== undefined) {
      const deletion = await archiveJobDeletions(this.connection).findOne({
        _id: 'job:' + this.guildId + ':' + confirmation.requestId,
        guildId: this.guildId,
      });
      if (deletion === null) {
        const existing = await this.jobsCollection().findOne({
          requestId: confirmation.requestId,
          guildId: this.guildId,
          status: 'running',
        });
        if (existing !== null) return safeArchiveJobSummary(existing);
      }
      throw new Error('Archive confirmation expired');
    }
    if (confirmation.consumedAt === undefined) {
      if (confirmation.expiresAt <= Date.now()) throw new Error('Archive confirmation expired');
      const run = await this.run(confirmation.runId);
      this.assertSettings(run);
      if (!this.eligible(confirmation.action, run))
        throw new Error('Repair run changed; request confirmation again');
      if ((await this.manifestHash(run)) !== confirmation.manifestHash)
        throw new Error('Repair manifest changed; request confirmation again');
      const summary = await this.summarizeManifest(run);
      if (summary.status !== 'available')
        throw new Error('Archive manifest summary unavailable; inspect the run again');
      const current = await this.run(confirmation.runId);
      if ((await this.manifestHash(current)) !== confirmation.manifestHash)
        throw new Error('Repair manifest changed; request confirmation again');
      if (
        !(await this.runState(current, summary, confirmation.requestId)).actions.includes(
          confirmation.action,
        )
      )
        throw new Error('Repair run changed; request confirmation again');
      const consumed = await this.confirmations().updateOne(
        {
          ...filter,
          consumedAt: { $exists: false },
          expiresAt: { $gt: Date.now() },
          manifestHash: confirmation.manifestHash,
        },
        { $set: { consumedAt: Date.now() } },
      );
      if (consumed.modifiedCount === 0) {
        const raced = await this.confirmations().findOne(filter);
        if (raced?.consumedAt === undefined) throw new Error('Archive confirmation expired');
      }
    }
    // An interrupted submit is retried with the durable request ID, even after expiry.
    const job = await this.enqueue(
      confirmation.action,
      {},
      confirmation.requestId,
      confirmation.runId,
      notification,
    );
    const receipt = await this.confirmations().findOne(filter);
    if (receipt?.purgedAt !== undefined) {
      // Close a replay that read the approval before purge marked its receipt.
      await this.jobsCollection().deleteOne({
        jobId: job.jobId,
        guildId: this.guildId,
        status: 'queued',
      });
      const running = await this.jobsCollection().findOne({
        jobId: job.jobId,
        guildId: this.guildId,
        status: 'running',
      });
      if (running !== null) return safeArchiveJobSummary(running);
      throw new Error('Archive confirmation expired');
    }
    return job;
  }
}
