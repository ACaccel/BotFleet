import type { ArchiveSchedule, ArchiveScheduleChange } from '../../core/archive/schedule';
import type { ArchiveCoverage, ArchiveFullBackupJob, ArchiveJob } from '../../core/archive/types';
import type { GuildId } from '../../core/ids';
import type { GuildConnection } from '../../persistence/connection';
import type { ArchivePanelRef } from '../../persistence/repositories/archive-control.repo';
import type { ArchiveReposFactory } from '../../persistence/repositories/archive-repos';
import { ArchiveConfirmationService, type ArchivePanelActor } from './control-confirmation';
import { ArchiveJobCommands } from './control-jobs';
import { ArchiveScheduleSettings } from './control-schedule';
import { archiveSnowflake, type ArchiveControlStores, type ControlResult } from './control-shared';
import { ArchiveStatusQueries, type ArchiveGapPage, type ArchiveStatus } from './control-status';

export { ARCHIVE_CONFIRMATION_TTL_MS, type ArchivePanelActor } from './control-confirmation';
export type { ArchiveControlStores } from './control-shared';
export type { ArchiveGapPage, ArchiveStatus } from './control-status';

/**
 * Discord control of one guild's archive, as the `/archive` command and panel
 * buttons see it. Expected rejections (a stale, foreign or expired request, a
 * conflicting backup) are returned as `ArchiveControlError`; invalid arguments
 * throw `ZodError`, and database faults propagate.
 */
export interface ArchiveControl {
  readSchedule(): Promise<ArchiveSchedule>;
  /** Changes only the given settings; unchanged settings keep the next run time. */
  updateSchedule(change: ArchiveScheduleChange): Promise<ArchiveSchedule>;
  /** The newest full backup in any state. */
  latestFullBackup(): Promise<ArchiveFullBackupJob | undefined>;
  job(jobId: string): ControlResult<ArchiveFullBackupJob>;
  /** Persists a single-use start approval bound to the operator, channel and panel. */
  requestConfirmation(actor: ArchivePanelActor): Promise<{ token: string; expiresAt: number }>;
  /** Consumes the approval and creates the full backup; a replay returns the same job. */
  confirm(token: string, actor: ArchivePanelActor): ControlResult<ArchiveFullBackupJob>;
  cancelConfirmation(token: string, actor: ArchivePanelActor): ControlResult<void>;
  /** Requests a cooperative stop. */
  stop(jobId: string): ControlResult<ArchiveFullBackupJob>;
  /** Queues the newest stopped or failed backup again; `panel` follows it. */
  resume(jobId: string, panel: ArchivePanelRef): ControlResult<ArchiveFullBackupJob>;
  /** Detaches the newest stopped or failed backup from `panel` before starting over. */
  prepareRestart(jobId: string, panel: ArchivePanelRef): ControlResult<void>;
  /** Moves the panel that follows a full backup, or switches its page. */
  setPanel(jobId: string, panel: ArchivePanelRef & { view: 'progress' | 'gaps' }): Promise<void>;
  /** Detaches a finished backup from a panel that now shows something else. */
  releasePanel(jobId: string, messageId: string): Promise<void>;
  /** Retained full-backup and periodic records, newest first. */
  recentRecords(): Promise<ArchiveJob[]>;
  /** Stored sources the bot cannot back up, grouped by reason then name. */
  gapChannels(page: number): Promise<ArchiveGapPage>;
  coverage(): Promise<ArchiveCoverage>;
  /** Bytes of `messages` and `archive_*` data and indexes in this guild's database. */
  archiveBytes(): Promise<number | undefined>;
  /** Live events abandoned after repeated reconciliation failures. */
  deadLetterCount(): Promise<number>;
  status(): Promise<ArchiveStatus>;
}

/**
 * Discord control enqueues full-backup work and reads archive status; the archive
 * owner performs every archive mutation.
 *
 * Pattern: Facade — one `ArchiveControl` contract over the job commands, start
 * confirmations, schedule settings and status queries, so handlers depend on a
 * single port.
 */
export class ArchiveControlService implements ArchiveControl {
  private readonly jobs: ArchiveJobCommands;
  private readonly confirmations: ArchiveConfirmationService;
  private readonly queries: ArchiveStatusQueries;
  private readonly schedule: ArchiveScheduleSettings;

  public constructor(stores: ArchiveControlStores, guildId: GuildId) {
    const guild = archiveSnowflake.parse(guildId);
    this.jobs = new ArchiveJobCommands(stores.control, guild);
    this.confirmations = new ArchiveConfirmationService(stores.control, guild);
    this.queries = new ArchiveStatusQueries(stores);
    this.schedule = new ArchiveScheduleSettings(stores.schedule);
  }

  public async readSchedule(): Promise<ArchiveSchedule> {
    return this.schedule.read();
  }

  public async updateSchedule(change: ArchiveScheduleChange): Promise<ArchiveSchedule> {
    return this.schedule.update(change);
  }

  public async latestFullBackup(): Promise<ArchiveFullBackupJob | undefined> {
    return this.jobs.latestFullBackup();
  }

  public async job(jobId: string): ControlResult<ArchiveFullBackupJob> {
    return this.jobs.job(jobId);
  }

  public async requestConfirmation(
    actor: ArchivePanelActor,
  ): Promise<{ token: string; expiresAt: number }> {
    return this.confirmations.requestConfirmation(actor);
  }

  public async confirm(
    token: string,
    actor: ArchivePanelActor,
  ): ControlResult<ArchiveFullBackupJob> {
    return this.confirmations.confirm(token, actor);
  }

  public async cancelConfirmation(token: string, actor: ArchivePanelActor): ControlResult<void> {
    return this.confirmations.cancelConfirmation(token, actor);
  }

  public async stop(jobId: string): ControlResult<ArchiveFullBackupJob> {
    return this.jobs.stop(jobId);
  }

  public async resume(jobId: string, panel: ArchivePanelRef): ControlResult<ArchiveFullBackupJob> {
    return this.jobs.resume(jobId, panel);
  }

  public async prepareRestart(jobId: string, panel: ArchivePanelRef): ControlResult<void> {
    return this.jobs.prepareRestart(jobId, panel);
  }

  public async setPanel(
    jobId: string,
    panel: ArchivePanelRef & { view: 'progress' | 'gaps' },
  ): Promise<void> {
    return this.jobs.setPanel(jobId, panel);
  }

  public async releasePanel(jobId: string, messageId: string): Promise<void> {
    return this.jobs.releasePanel(jobId, messageId);
  }

  public async recentRecords(): Promise<ArchiveJob[]> {
    return this.queries.recentRecords();
  }

  public async gapChannels(page: number): Promise<ArchiveGapPage> {
    return this.queries.gapChannels(page);
  }

  public async coverage(): Promise<ArchiveCoverage> {
    return this.queries.coverage();
  }

  public async archiveBytes(): Promise<number | undefined> {
    return this.queries.archiveBytes();
  }

  public async deadLetterCount(): Promise<number> {
    return this.queries.deadLetterCount();
  }

  public async status(): Promise<ArchiveStatus> {
    return this.queries.status();
  }
}

/** What a composition root needs to build one guild's archive control. */
export interface ArchiveControlTarget {
  /** The guild database; it must be open. */
  readonly guild: GuildConnection;
  /** Interval of a schedule no operator has saved yet. */
  readonly defaultIntervalMs: number;
}

/** Builds archive control for one guild; registered as `TOKENS.ArchiveControlFactory`. */
export type ArchiveControlFactory = (target: ArchiveControlTarget) => ArchiveControl;

/**
 * The archive control factory over the given repositories; the msg-archive
 * composition root binds `archiveControlFactory(buildArchiveRepos)`.
 */
export const archiveControlFactory =
  (repos: ArchiveReposFactory): ArchiveControlFactory =>
  ({ guild, defaultIntervalMs }) => {
    const guildRepos = repos(guild);
    return new ArchiveControlService(
      { ...guildRepos, schedule: guildRepos.schedule(defaultIntervalMs) },
      guild.guildId,
    );
  };
