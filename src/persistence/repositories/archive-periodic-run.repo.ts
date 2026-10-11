import type { Connection } from 'mongoose';
import type { ArchivePeriodicRun, ArchiveRunOrigin } from '../../core/archive/types';

/** The current periodic run of one guild; finished passes become `archive_jobs` records. */
export interface ArchivePeriodicRunRepo {
  /** The current run, finished or not; `null` before the first run. */
  current(): Promise<ArchivePeriodicRun | null>;
  /** Only the continuity origin of the current run. */
  currentOrigin(): Promise<{ readonly origin?: ArchiveRunOrigin } | null>;
  /** Makes `run` the current run, replacing the previous one. */
  replace(run: ArchivePeriodicRun): Promise<void>;
  /** Updates the current run while it is still `runId`. */
  update(runId: string, fields: Partial<Omit<ArchivePeriodicRun, '_id' | 'runId'>>): Promise<void>;
}

/** Per-guild `archive_periodic_runs` record (`_id: 'current'`); only the archive owner writes it. */
export class MongoArchivePeriodicRunRepo implements ArchivePeriodicRunRepo {
  public constructor(private readonly connection: Connection) {}

  private collection() {
    return this.connection.collection<ArchivePeriodicRun>('archive_periodic_runs');
  }

  public async current(): Promise<ArchivePeriodicRun | null> {
    return this.collection().findOne({ _id: 'current' });
  }

  public async currentOrigin(): Promise<{ readonly origin?: ArchiveRunOrigin } | null> {
    return this.collection().findOne({ _id: 'current' }, { projection: { origin: 1 } });
  }

  public async replace(run: ArchivePeriodicRun): Promise<void> {
    await this.collection().replaceOne({ _id: 'current' }, run, { upsert: true });
  }

  public async update(
    runId: string,
    fields: Partial<Omit<ArchivePeriodicRun, '_id' | 'runId'>>,
  ): Promise<void> {
    await this.collection().updateOne({ _id: 'current', runId }, { $set: fields });
  }
}
