import type { Connection } from 'mongoose';
import type {
  ArchiveInvalidRequestAlert,
  ArchivePeriodicMessageRef,
  ArchiveNoticeSlot,
  ArchivePassHealth,
  ArchiveSchedule,
  ArchiveScheduleChange,
} from '../../core/archive/schedule';

/** Consecutive failed passes that raise one failing notice. */
const ARCHIVE_FAILURE_ALERT_THRESHOLD = 3;

type ScheduleDocument = ArchiveSchedule & { _id: string };
/**
 * The invalid-request episode is its own document, so its notice never displaces a
 * periodic-health notice and raising it never creates the schedule record.
 */
type InvalidRequestDocument = ArchiveInvalidRequestAlert & { _id: 'invalid-requests' };
const INVALID_REQUESTS_ID = 'invalid-requests';
const noticeFilter = (slot: ArchiveNoticeSlot, createdAt: number) => ({
  _id: slot === 'schedule' ? 'current' : INVALID_REQUESTS_ID,
  'notice.createdAt': createdAt,
});

/** Schedule settings, pass claims and the periodic-health notice of one guild. */
export interface ArchiveScheduleRepo {
  read(): Promise<ArchiveSchedule>;
  update(change: ArchiveScheduleChange): Promise<ArchiveSchedule>;
  recover(): Promise<void>;
  start(): Promise<ArchiveSchedule | null>;
  finish(revision: number, retryDelayMs?: number, health?: ArchivePassHealth): Promise<void>;
  markNoticeDelivered(createdAt: number, slot?: ArchiveNoticeSlot): Promise<void>;
  deferNotice(
    createdAt: number,
    attempts: number,
    retryAt: number,
    slot?: ArchiveNoticeSlot,
  ): Promise<void>;
  abandonNotice(createdAt: number, slot?: ArchiveNoticeSlot): Promise<void>;
  /** Records the newest pass panel and returns the one it replaces. */
  replaceSummary(
    summary: ArchivePeriodicMessageRef,
  ): Promise<ArchivePeriodicMessageRef | undefined>;
  readInvalidRequests(): Promise<ArchiveInvalidRequestAlert>;
  /**
   * Raises the episode's warning unless one is already raised, or its recovery
   * when one is. `raised`: the notice is stored and pending; `unchanged`: the
   * episode already is in that state; `waiting`: the warning is not delivered or
   * abandoned yet, so the recovery must wait and not replace it.
   */
  raiseInvalidRequestNotice(
    change:
      | { readonly kind: 'invalid-requests'; readonly count: number }
      | { readonly kind: 'invalid-requests-recovered' },
  ): Promise<'raised' | 'unchanged' | 'waiting'>;
}

/**
 * Per-guild `archive_schedule` record. Message ownership remains with the archive
 * worker; the `/archive schedule` command changes only the settings.
 */
export class MongoArchiveScheduleRepo implements ArchiveScheduleRepo {
  public constructor(
    private readonly connection: Connection,
    private readonly defaultIntervalMs: number,
  ) {
    if (
      !Number.isInteger(defaultIntervalMs) ||
      defaultIntervalMs <= 0 ||
      defaultIntervalMs > 2_147_483_647
    )
      throw new TypeError('Invalid archive backup interval');
  }

  private collection() {
    return this.connection.collection<ScheduleDocument>('archive_schedule');
  }

  private defaults(): ScheduleDocument {
    return {
      _id: 'current',
      enabled: false,
      intervalMs: this.defaultIntervalMs,
      nextRunAt: null,
      running: false,
      revision: 0,
      pauseVersion: 0,
    };
  }

  public async read(): Promise<ArchiveSchedule> {
    return (await this.collection().findOne({ _id: 'current' })) ?? this.defaults();
  }

  public async update(change: ArchiveScheduleChange): Promise<ArchiveSchedule> {
    if (
      change.intervalMs !== undefined &&
      (!Number.isInteger(change.intervalMs) ||
        change.intervalMs < 60_000 ||
        change.intervalMs > 604_800_000)
    )
      throw new TypeError('Archive interval must be between one minute and one week');
    const differences = [
      ...(change.enabled === undefined ? [] : [{ enabled: { $ne: change.enabled } }]),
      ...(change.intervalMs === undefined ? [] : [{ intervalMs: { $ne: change.intervalMs } }]),
    ];
    if (differences.length === 0) return this.read();
    const now = Date.now();
    // Only initialization uses upsert, so concurrent commands never replace settings.
    await this.collection().updateOne(
      { _id: 'current' },
      { $setOnInsert: this.defaults() },
      { upsert: true },
    );
    const result = await this.collection().findOneAndUpdate(
      { _id: 'current', $or: differences },
      [
        // Every expression in one `$set` stage reads the stored document, so `$enabled`
        // below is the state before this command. Only enabling a disabled schedule
        // makes a pass due now; an interval change on an enabled schedule (including
        // `enable minutes:<value>`) counts from the change time.
        {
          $set: {
            ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
            ...(change.intervalMs === undefined ? {} : { intervalMs: change.intervalMs }),
            revision: { $add: ['$revision', 1] },
            pauseVersion: { $add: ['$pauseVersion', change.enabled === false ? 1 : 0] },
            nextRunAt: {
              $cond: [
                change.enabled ?? '$enabled',
                { $cond: ['$enabled', { $add: [now, change.intervalMs ?? '$intervalMs'] }, now] },
                null,
              ],
            },
          },
        },
      ],
      { returnDocument: 'after' },
    );
    // Repeated settings must not postpone the next pass or invalidate a running pass.
    return result ?? this.read();
  }

  /** Called only after the worker has acquired exclusive archive ownership. */
  public async recover(): Promise<void> {
    await this.collection().updateOne({ _id: 'current' }, { $set: { running: false } });
  }

  public async start(): Promise<ArchiveSchedule | null> {
    return this.collection().findOneAndUpdate(
      { _id: 'current', enabled: true, running: false, nextRunAt: { $lte: Date.now() } },
      { $set: { running: true } },
      { returnDocument: 'after' },
    );
  }

  /**
   * Releases the pass claim. The next pass is due after `retryDelayMs` (from
   * `archiveRetryDelay`), capped at the interval, or after the interval when omitted.
   * `health` updates the failure streak in the same write: the pass that reaches
   * the threshold raises one failing notice, and the next complete pass after it
   * raises one recovered notice.
   */
  public async finish(
    revision: number,
    retryDelayMs?: number,
    health: ArchivePassHealth = { kind: 'neutral' },
  ): Promise<void> {
    if (retryDelayMs !== undefined && (!Number.isSafeInteger(retryDelayMs) || retryDelayMs <= 0))
      throw new TypeError('Invalid archive retry delay');
    const now = Date.now();
    const delay =
      retryDelayMs === undefined ? '$intervalMs' : { $min: [retryDelayMs, '$intervalMs'] };
    const alerted = { $ifNull: ['$alerted', false] };
    // A command issued during the pass takes precedence over its completion timer.
    await this.collection().updateOne({ _id: 'current' }, [
      {
        $set: {
          running: false,
          nextRunAt: {
            $cond: [
              { $and: ['$enabled', { $eq: ['$revision', revision] }] },
              { $add: [now, delay] },
              '$nextRunAt',
            ],
          },
          ...(health.kind === 'failure'
            ? {
                failureStreak: { $add: [{ $ifNull: ['$failureStreak', 0] }, 1] },
                lastFailureReason: health.reason,
              }
            : {}),
          ...(health.kind === 'success'
            ? {
                failureStreak: 0,
                lastCompletedAt: now,
                alerted: false,
                notice: {
                  $cond: [
                    alerted,
                    {
                      kind: 'recovered',
                      failures: { $ifNull: ['$failureStreak', 0] },
                      createdAt: now,
                    },
                    '$notice',
                  ],
                },
              }
            : {}),
        },
      },
      // Reads the streak counted above; both fields read the previous `alerted`.
      ...(health.kind === 'failure'
        ? [
            {
              $set: {
                notice: {
                  $cond: [
                    {
                      $and: [
                        { $not: [alerted] },
                        { $gte: ['$failureStreak', ARCHIVE_FAILURE_ALERT_THRESHOLD] },
                      ],
                    },
                    {
                      kind: 'failing',
                      failures: '$failureStreak',
                      reason: '$lastFailureReason',
                      createdAt: now,
                    },
                    '$notice',
                  ],
                },
                alerted: {
                  $or: [alerted, { $gte: ['$failureStreak', ARCHIVE_FAILURE_ALERT_THRESHOLD] }],
                },
              },
            },
          ]
        : []),
    ]);
  }

  /** Marks a notice delivered; a newer notice raised meanwhile stays pending. */
  public async markNoticeDelivered(
    createdAt: number,
    slot: ArchiveNoticeSlot = 'schedule',
  ): Promise<void> {
    await this.collection().updateOne(noticeFilter(slot, createdAt), {
      $set: { 'notice.deliveredAt': Date.now() },
    });
  }

  /** Records a failed send; the next attempt waits until `retryAt`. */
  public async deferNotice(
    createdAt: number,
    attempts: number,
    retryAt: number,
    slot: ArchiveNoticeSlot = 'schedule',
  ): Promise<void> {
    await this.collection().updateOne(noticeFilter(slot, createdAt), {
      $set: { 'notice.attempts': attempts, 'notice.retryAt': retryAt },
    });
  }

  /** Stops retrying a notice Discord refused permanently. */
  public async abandonNotice(
    createdAt: number,
    slot: ArchiveNoticeSlot = 'schedule',
  ): Promise<void> {
    await this.collection().updateOne(noticeFilter(slot, createdAt), {
      $set: { 'notice.abandonedAt': Date.now() },
    });
  }

  public async replaceSummary(
    summary: ArchivePeriodicMessageRef,
  ): Promise<ArchivePeriodicMessageRef | undefined> {
    const before = await this.collection().findOneAndUpdate(
      { _id: 'current' },
      { $set: { summary: { ...summary } }, $setOnInsert: this.defaults() },
      { upsert: true, returnDocument: 'before', projection: { summary: 1 } },
    );
    return before?.summary;
  }

  private invalidRequests() {
    return this.connection.collection<InvalidRequestDocument>('archive_schedule');
  }

  public async readInvalidRequests(): Promise<ArchiveInvalidRequestAlert> {
    const stored = await this.invalidRequests().findOne({ _id: INVALID_REQUESTS_ID });
    if (stored === null) return { alerted: false };
    const { _id: _ignored, ...alert } = stored;
    return alert;
  }

  public async raiseInvalidRequestNotice(
    change:
      | { readonly kind: 'invalid-requests'; readonly count: number }
      | { readonly kind: 'invalid-requests-recovered' },
  ): Promise<'raised' | 'unchanged' | 'waiting'> {
    const raising = change.kind === 'invalid-requests';
    const notice = { $set: { alerted: raising, notice: { ...change, createdAt: Date.now() } } };
    if (raising) {
      // The conditional filter makes raising idempotent across workers and restarts;
      // only a first warning creates the document. A new warning may replace an
      // unsent recovery: the episode it reports is the current state.
      const result = await this.invalidRequests()
        .updateOne({ _id: INVALID_REQUESTS_ID, alerted: { $ne: true } }, notice, {
          upsert: true,
        })
        .catch((error: unknown) => {
          // A concurrent first warning inserted the document; this one is a duplicate.
          if ((error as { code?: unknown } | null)?.code === 11000) return undefined;
          throw error;
        });
      return result !== undefined && (result.modifiedCount > 0 || result.upsertedCount > 0)
        ? 'raised'
        : 'unchanged';
    }
    // A recovery never replaces a warning that has not reached Discord yet.
    const result = await this.invalidRequests().updateOne(
      {
        _id: INVALID_REQUESTS_ID,
        alerted: true,
        $or: [
          { 'notice.kind': { $ne: 'invalid-requests' } },
          { 'notice.deliveredAt': { $exists: true } },
          { 'notice.abandonedAt': { $exists: true } },
        ],
      },
      notice,
    );
    if (result.modifiedCount > 0) return 'raised';
    return (await this.readInvalidRequests()).alerted ? 'waiting' : 'unchanged';
  }
}
