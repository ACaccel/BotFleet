import type { ArchiveSchedule, ArchiveScheduleChange } from '../../core/archive/schedule';
import type { ArchiveScheduleRepo } from '../../persistence/repositories/archive-schedule.repo';

/** One guild's periodic backup schedule settings. */
export class ArchiveScheduleSettings {
  public constructor(private readonly schedule: ArchiveScheduleRepo) {}

  public async read(): Promise<ArchiveSchedule> {
    return this.schedule.read();
  }

  /** Changes only the given settings; unchanged settings keep the next run time. */
  public async update(change: ArchiveScheduleChange): Promise<ArchiveSchedule> {
    return this.schedule.update(change);
  }
}
