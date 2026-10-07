import type { Connection } from 'mongoose';
import { z } from 'zod';
import {
  archiveManifestCategory,
  type archiveManifestCategories,
} from '../../core/archive/manifest-summary';
import {
  safeArchiveOperationTarget,
  type ArchiveManifestGroup,
  type ArchiveManifestGroupFilter,
  type ArchiveManifestPage,
  type ArchiveManifestSource,
} from '../../core/archive/manifest-target';
import {
  archiveManifestFilter,
  archiveOperationProjection,
  archiveOperationStateExpression,
  MANIFEST_QUERY_TIMEOUT_MS,
} from './manifest-query';

export const archiveManifestGroupSchema = z.object({
  reason: z.string().regex(/^[A-Za-z0-9:_-]{1,160}$/),
  collection: z.string().regex(/^[A-Za-z0-9:_-]{1,160}$/),
  impact: z.enum(['insert', 'update', 'delete', 'unknown']),
});
export const archiveManifestSourceSchema = z.string().regex(/^(?:\d{1,20}|unknown)$/);
const states = [
  'planned',
  'journaled',
  'applied',
  'verified',
  'rolled-back',
  'conflict',
  'unknown',
];
const stateSums = (combine = false): Record<string, unknown> =>
  Object.fromEntries(
    states.map((state, index) => [
      `state${index}`,
      { $sum: combine ? `$state${index}` : { $cond: [{ $eq: ['$safeState', state] }, 1, 0] } },
    ]),
  );
const safeStates = (row: Record<string, unknown>): Record<string, number> =>
  Object.fromEntries(
    states.flatMap((state, index) => {
      const value = row[`state${index}`];
      return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? [[state, value]]
        : [];
    }),
  );
const count = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid archive group counters');
  return value;
};
type Filter = {
  category?: (typeof archiveManifestCategories)[number];
  group?: ArchiveManifestGroupFilter;
};
type Cursor = { after?: string; before?: string; limit: number };
interface AggregatedPage extends Record<string, unknown> {
  page: Record<string, unknown>[];
  bounds: { totalOperations: number; first: string; last: string }[];
}
const unavailable = <T, K extends string>(key: K, error: unknown): ArchiveManifestPage<T, K> =>
  ({
    status: 'unavailable',
    reason:
      typeof error === 'object' && error !== null && 'code' in error && error.code === 50
        ? 'timeout'
        : 'unavailable',
    [key]: [],
    hasNext: false,
    hasPrevious: false,
  }) as ArchiveManifestPage<T, K>;
const sourceGroups = (): Record<string, unknown>[] => [
  {
    $project: {
      ...archiveOperationProjection(),
      safeState: archiveOperationStateExpression(),
    },
  },
  {
    $set: {
      sourceKey: { $ifNull: ['$sourceId', 'unknown'] },
      groupKey: { $concat: ['$collection', '|', '$reason', '|', '$impact'] },
    },
  },
  {
    $group: {
      _id: { group: '$groupKey', source: '$sourceKey' },
      collection: { $first: '$collection' },
      reason: { $first: '$reason' },
      impact: { $first: '$impact' },
      sourceId: { $first: '$sourceId' },
      sourceKey: { $first: '$sourceKey' },
      historicalName: { $max: '$historicalName' },
      parentId: { $max: '$parentId' },
      sourceType: { $max: '$sourceType' },
      operations: { $sum: 1 },
      ...stateSums(),
    },
  },
];

/** A facet bounds both returned rows and examples while counting the complete filter on the server. */
const paginated = (cursor: Cursor): Record<string, unknown> => ({
  $facet: {
    page: [
      ...(cursor.after === undefined && cursor.before === undefined
        ? []
        : [
            {
              $match: {
                _id: cursor.before === undefined ? { $gt: cursor.after } : { $lt: cursor.before },
              },
            },
          ]),
      { $sort: { _id: cursor.before === undefined ? 1 : -1 } },
      { $limit: cursor.limit + 1 },
    ],
    bounds: [
      {
        $group: {
          _id: null,
          totalOperations: { $sum: '$operations' },
          first: { $min: '$_id' },
          last: { $max: '$_id' },
        },
      },
    ],
  },
});
const pageData = (data: AggregatedPage | undefined, cursor: Cursor) => {
  const rows = (data?.page ?? []).slice(0, cursor.limit);
  if (cursor.before !== undefined) rows.reverse();
  const bounds = data?.bounds[0];
  const first = rows.at(0)?.['_id'];
  const last = rows.at(-1)?.['_id'];
  if (
    (first !== undefined && typeof first !== 'string') ||
    (last !== undefined && typeof last !== 'string')
  )
    throw new Error('Invalid archive group cursor');
  const hasPrevious = bounds !== undefined && typeof first === 'string' && bounds.first < first;
  const hasNext = bounds !== undefined && typeof last === 'string' && bounds.last > last;
  return {
    rows,
    totalOperations: count(bounds?.totalOperations ?? 0),
    hasPrevious,
    hasNext,
    ...(hasPrevious ? { previousCursor: first as string } : {}),
    ...(hasNext ? { nextCursor: last as string } : {}),
  };
};
export class ArchiveManifestQueries {
  public constructor(private readonly connection: Connection) {}
  public async groups(
    runId: string,
    filter: Filter,
    cursor: Cursor,
  ): Promise<ArchiveManifestPage<ArchiveManifestGroup, 'groups'>> {
    try {
      const data = await this.connection
        .collection('archive_repair_operations')
        .aggregate<AggregatedPage>(
          [
            { $match: { runId, ...archiveManifestFilter(filter) } },
            ...sourceGroups(),
            {
              $group: {
                _id: '$_id.group',
                collection: { $first: '$collection' },
                reason: { $first: '$reason' },
                impact: { $first: '$impact' },
                operations: { $sum: '$operations' },
                sourceCount: { $sum: { $cond: [{ $eq: ['$sourceKey', 'unknown'] }, 0, 1] } },
                unknownSourceOperations: {
                  $sum: { $cond: [{ $eq: ['$sourceKey', 'unknown'] }, '$operations', 0] },
                },
                examples: {
                  $topN: {
                    n: 3,
                    sortBy: { sourceKey: 1 },
                    output: {
                      sourceId: '$sourceId',
                      historicalName: '$historicalName',
                      parentId: '$parentId',
                      sourceType: '$sourceType',
                    },
                  },
                },
                ...stateSums(true),
              },
            },
            paginated(cursor),
          ],
          { maxTimeMS: MANIFEST_QUERY_TIMEOUT_MS, allowDiskUse: false },
        )
        .toArray();
      const page = pageData(data[0], cursor);
      const groups = page.rows.map(
        (row): ArchiveManifestGroup => ({
          key: String(row['_id']),
          ...archiveManifestGroupSchema.parse({
            reason: row['reason'],
            collection: row['collection'],
            impact: row['impact'],
          }),
          category: archiveManifestCategory(row['collection'], row['reason']),
          operations: count(row['operations']),
          sourceCount: count(row['sourceCount']),
          unknownSourceOperations: count(row['unknownSourceOperations']),
          states: safeStates(row),
          examples: (Array.isArray(row['examples']) ? row['examples'] : [])
            .map((target: Record<string, unknown>) => safeArchiveOperationTarget(target))
            .filter((target) => target.identity === 'known'),
        }),
      );
      const { rows: _rows, ...pagination } = page;
      return { status: 'available', groups, ...pagination };
    } catch (error: unknown) {
      return unavailable('groups', error);
    }
  }
  public async sources(
    runId: string,
    filter: Filter,
    cursor: Cursor,
  ): Promise<ArchiveManifestPage<ArchiveManifestSource, 'sources'>> {
    try {
      const data = await this.connection
        .collection('archive_repair_operations')
        .aggregate<AggregatedPage>(
          [
            { $match: { runId, ...archiveManifestFilter(filter) } },
            ...sourceGroups(),
            {
              $group: {
                _id: '$sourceKey',
                sourceId: { $first: '$sourceId' },
                historicalName: { $max: '$historicalName' },
                parentId: { $max: '$parentId' },
                sourceType: { $max: '$sourceType' },
                operations: { $sum: '$operations' },
                ...stateSums(true),
              },
            },
            paginated(cursor),
          ],
          { maxTimeMS: MANIFEST_QUERY_TIMEOUT_MS, allowDiskUse: false },
        )
        .toArray();
      const page = pageData(data[0], cursor);
      const sources = page.rows.map(
        (row): ArchiveManifestSource => ({
          sourceId: archiveManifestSourceSchema.parse(row['_id']),
          target: safeArchiveOperationTarget(row),
          operations: count(row['operations']),
          states: safeStates(row),
        }),
      );
      const { rows: _rows, ...pagination } = page;
      return { status: 'available', sources, ...pagination };
    } catch (error: unknown) {
      return unavailable('sources', error);
    }
  }
}
