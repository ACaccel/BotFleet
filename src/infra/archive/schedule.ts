import type { Connection } from 'mongoose';

interface ArchiveSchedule {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly nextRunAt: number | null;
  readonly running: boolean;
  readonly revision: number;
  readonly pauseVersion: number;
}

type ScheduleDocument = ArchiveSchedule & { _id: string };

/** Per-guild schedule state. Message ownership remains with the archive worker. */
export class ArchiveScheduleStore {
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

  public async update(change: {
    enabled?: boolean;
    intervalMs?: number;
  }): Promise<ArchiveSchedule> {
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
        {
          $set: {
            ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
            ...(change.intervalMs === undefined ? {} : { intervalMs: change.intervalMs }),
            revision: { $add: ['$revision', 1] },
            pauseVersion: { $add: ['$pauseVersion', change.enabled === false ? 1 : 0] },
          },
        },
        {
          $set: {
            nextRunAt: {
              $cond: [
                '$enabled',
                change.enabled === true ? now : { $add: [now, '$intervalMs'] },
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

  public async finish(revision: number): Promise<void> {
    // A command issued during the pass takes precedence over its completion timer.
    await this.collection().updateOne({ _id: 'current' }, [
      {
        $set: {
          running: false,
          nextRunAt: {
            $cond: [
              { $and: ['$enabled', { $eq: ['$revision', revision] }] },
              { $add: [Date.now(), '$intervalMs'] },
              '$nextRunAt',
            ],
          },
        },
      },
    ]);
  }
}
