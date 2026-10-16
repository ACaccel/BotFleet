import type { GuildConnection } from '../connection';
import { MongoArchiveRepo, type ArchiveRepo } from './archive.repo';
import { MongoArchiveChannelRepo, type ArchiveChannelRepo } from './archive-channel.repo';
import { MongoArchiveContinuityRepo, type ArchiveContinuityRepo } from './archive-continuity.repo';
import { MongoArchiveControlRepo, type ArchiveControlRepo } from './archive-control.repo';
import { MongoArchiveInboxRepo, type ArchiveInboxRepo } from './archive-inbox.repo';
import { MongoArchiveJobRepo, type ArchiveJobRepo } from './archive-job.repo';
import { MongoArchiveOwnerRepo, type ArchiveOwnerRepo } from './archive-owner.repo';
import {
  MongoArchivePeriodicRunRepo,
  type ArchivePeriodicRunRepo,
} from './archive-periodic-run.repo';
import { MongoArchiveReactionRepo, type ArchiveReactionRepo } from './archive-reaction.repo';
import { MongoArchiveScheduleRepo, type ArchiveScheduleRepo } from './archive-schedule.repo';
import {
  MongoArchiveStorageUsageRepo,
  type ArchiveStorageUsageRepo,
} from './archive-storage-usage.repo';

/**
 * One guild's archive metadata repositories: what Discord control and the
 * archive worker share besides the worker's own {@link ArchiveWriterRepos}.
 */
export interface ArchiveRepos {
  readonly control: ArchiveControlRepo;
  readonly periodicRuns: ArchivePeriodicRunRepo;
  readonly continuity: ArchiveContinuityRepo;
  readonly storage: ArchiveStorageUsageRepo;
  /** The schedule; `defaultIntervalMs` applies until an operator saves an interval. */
  schedule(defaultIntervalMs: number): ArchiveScheduleRepo;
}

export type ArchiveReposFactory = (guild: GuildConnection) => ArchiveRepos;

/** Builds the Mongo archive metadata repositories over one open guild database. */
export const buildArchiveRepos: ArchiveReposFactory = (guild) => ({
  control: new MongoArchiveControlRepo(guild.connection, String(guild.guildId)),
  periodicRuns: new MongoArchivePeriodicRunRepo(guild.connection),
  continuity: new MongoArchiveContinuityRepo(guild.connection),
  storage: new MongoArchiveStorageUsageRepo(guild.connection),
  schedule: (defaultIntervalMs) =>
    new MongoArchiveScheduleRepo(guild.connection, defaultIntervalMs),
});

/** One guild's archive writer repositories; only the msg-archive owner builds them. */
export interface ArchiveWriterRepos {
  readonly messages: ArchiveRepo;
  readonly inbox: ArchiveInboxRepo;
  readonly reactions: ArchiveReactionRepo;
  readonly channels: ArchiveChannelRepo;
  readonly jobs: ArchiveJobRepo;
  readonly owner: ArchiveOwnerRepo;
}

export type ArchiveWriterReposFactory = (guild: GuildConnection) => ArchiveWriterRepos;

/**
 * Builds the Mongo archive writer repositories over one open guild database; each
 * rejects a connection without msg-archive ownership.
 */
export const buildArchiveWriterRepos: ArchiveWriterReposFactory = (guild) => ({
  messages: new MongoArchiveRepo(guild, 'msg-archive'),
  inbox: new MongoArchiveInboxRepo(guild, 'msg-archive'),
  reactions: new MongoArchiveReactionRepo(guild, 'msg-archive'),
  channels: new MongoArchiveChannelRepo(guild, 'msg-archive'),
  jobs: new MongoArchiveJobRepo(guild, 'msg-archive'),
  owner: new MongoArchiveOwnerRepo(guild, 'msg-archive'),
});
