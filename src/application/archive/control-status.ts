import { z } from 'zod';
import { ARCHIVE_JOB_RECORDS_KEPT } from '../../core/archive/limits';
import type { ArchiveSchedule } from '../../core/archive/schedule';
import type {
  ArchiveCoverage,
  ArchiveFullBackupJob,
  ArchiveGapChannel,
  ArchiveHostUsage,
  ArchiveJob,
  ArchivePeriodicRun,
} from '../../core/archive/types';
import type { ArchiveControlStores } from './control-shared';

const ARCHIVE_GAP_PAGE_SIZE = 10;

export interface ArchiveStatus {
  readonly fullBackup?: ArchiveFullBackupJob;
  readonly periodicRun?: ArchivePeriodicRun;
  readonly schedule: ArchiveSchedule;
  readonly coverage: ArchiveCoverage;
  readonly continuity?: { readonly continuousSince: number };
  readonly inbox: { readonly pending: number; readonly dead: number };
  readonly host?: ArchiveHostUsage;
}
export interface ArchiveGapPage {
  readonly rows: ArchiveGapChannel[];
  readonly total: number;
  readonly page: number;
  readonly pages: number;
}

/** One guild's archive status reads. */
export class ArchiveStatusQueries {
  public constructor(private readonly stores: ArchiveControlStores) {}

  /** Retained full-backup and periodic records, newest first. */
  public async recentRecords(): Promise<ArchiveJob[]> {
    return this.stores.control.recentRecords(ARCHIVE_JOB_RECORDS_KEPT + 2);
  }

  /** Stored sources the bot cannot back up, grouped by reason then name. */
  public async gapChannels(page: number): Promise<ArchiveGapPage> {
    z.number().int().min(1).max(100_000).parse(page);
    const total = await this.stores.control.countGapChannels();
    const pages = Math.max(1, Math.ceil(total / ARCHIVE_GAP_PAGE_SIZE));
    const current = Math.min(page, pages);
    const rows = await this.stores.control.listGapChannels(
      (current - 1) * ARCHIVE_GAP_PAGE_SIZE,
      ARCHIVE_GAP_PAGE_SIZE,
    );
    return { rows, total, page: current, pages };
  }

  public async coverage(): Promise<ArchiveCoverage> {
    return this.stores.control.coverage();
  }

  /** Bytes of `messages` and `archive_*` data and indexes in this guild's database. */
  public async archiveBytes(): Promise<number | undefined> {
    return this.stores.storage.archiveBytes();
  }

  /** Live events abandoned after repeated reconciliation failures. */
  public async deadLetterCount(): Promise<number> {
    return this.stores.control.deadLetterCount();
  }

  public async status(): Promise<ArchiveStatus> {
    const [fullBackup, periodicRun, schedule, coverage, continuity, pending, dead, host] =
      await Promise.all([
        this.stores.control.latestFullBackup(),
        this.stores.periodicRuns.current(),
        this.stores.schedule.read(),
        this.coverage(),
        this.stores.continuity.read(),
        this.stores.control.openInboxCount(),
        this.deadLetterCount(),
        this.stores.storage.read(),
      ]);
    return {
      ...(fullBackup === undefined ? {} : { fullBackup }),
      ...(periodicRun === null ? {} : { periodicRun }),
      schedule,
      coverage,
      ...(continuity === null
        ? {}
        : { continuity: { continuousSince: continuity.continuousSince } }),
      inbox: { pending, dead },
      ...(host === undefined ? {} : { host }),
    };
  }
}
