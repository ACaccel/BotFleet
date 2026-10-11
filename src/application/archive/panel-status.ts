import { archiveJobProgress, sanitizeArchiveProgress } from '../../core/archive/progress';
import {
  isActiveBackup,
  type ArchiveCoverage,
  type ArchivePeriodicRun,
} from '../../core/archive/types';
import type { ArchiveStatus } from './control';
import { archiveBackupState, archiveButtons, type ArchivePanel } from './panel';
import type { ArchiveSchedule } from '../../core/archive/schedule';
import {
  ARCHIVE_COLORS,
  archiveBytes,
  archiveBytesOf,
  archiveCount,
  archiveDuration,
  archiveNumber,
  archiveTime,
  type ArchiveText,
} from './panel-format';

const fullBackupLine = (t: ArchiveText, status: ArchiveStatus, now: number): string => {
  const job = status.fullBackup;
  if (job === undefined) return t.t('replies:archive.status_backup_none');
  const state = archiveBackupState(job);
  const label = t.t(`replies:archive.backup_state_${state}`);
  if (isActiveBackup(job)) {
    const progress = archiveJobProgress(job, now);
    return t.t('replies:archive.status_backup_active', {
      state: label,
      completed: archiveNumber(progress.sources.completed),
      total:
        progress.sources.total > 0
          ? archiveNumber(progress.sources.total)
          : t.t('replies:archive.value_unknown'),
      elapsed: archiveDuration(t, progress.activeMs),
    });
  }
  return t.t('replies:archive.status_backup_finished', {
    state: label,
    finished: archiveTime(job.finishedAt ?? job.createdAt),
  });
};

const runningPass = (run: ArchivePeriodicRun | undefined, schedule: ArchiveSchedule) =>
  schedule.running && run?.status === 'running' ? sanitizeArchiveProgress(run.progress) : undefined;

const periodicLine = (t: ArchiveText, status: ArchiveStatus, now: number): string => {
  const { schedule } = status;
  const pass = runningPass(status.periodicRun, schedule);
  if (pass !== undefined)
    return t.t('replies:archive.status_periodic_running', {
      completed: archiveNumber(pass.sources.completed),
      total:
        pass.sources.total > 0
          ? archiveNumber(pass.sources.total)
          : t.t('replies:archive.value_unknown'),
      elapsed: archiveDuration(t, Math.max(0, now - (status.periodicRun?.passStartedAt ?? now))),
    });
  const lines = [
    t.t(
      schedule.enabled ? 'replies:archive.schedule_enabled' : 'replies:archive.schedule_disabled',
    ),
    t.t('replies:archive.schedule_every', { minutes: archiveNumber(schedule.intervalMs / 60_000) }),
    t.t('replies:archive.status_periodic_last', {
      last:
        schedule.lastCompletedAt === undefined
          ? t.t('replies:archive.value_never')
          : archiveTime(schedule.lastCompletedAt),
    }),
    ...(schedule.enabled && schedule.nextRunAt !== null
      ? [t.t('replies:archive.status_periodic_next', { next: archiveTime(schedule.nextRunAt) })]
      : []),
  ];
  return lines.join(t.t('replies:archive.field_separator'));
};

/** Only the non-zero reasons, e.g. `(permissions 2, deleted 1)`. */
const gapBreakdown = (t: ArchiveText, gaps: ArchiveCoverage['gaps']): string => {
  const parts = (['denied', 'deleted', 'unknown'] as const)
    .filter((access) => gaps[access] > 0)
    .map((access) =>
      t.t(`replies:archive.coverage_${access}`, { number: archiveNumber(gaps[access]) }),
    );
  return parts.length === 0
    ? ''
    : t.t('replies:archive.coverage_breakdown', {
        parts: parts.join(t.t('replies:archive.list_separator')),
      });
};

const coverageLine = (t: ArchiveText, status: ArchiveStatus): string => {
  const { readable, gaps } = status.coverage;
  const total = gaps.denied + gaps.deleted + gaps.unknown;
  if (readable + total === 0) return t.t('replies:archive.status_coverage_none');
  return t.t('replies:archive.status_coverage', {
    readable: archiveCount(t, 'count_readable_channels', readable),
    gaps: archiveCount(t, 'count_gaps', total),
    breakdown: gapBreakdown(t, gaps),
  });
};

/**
 * One panel with every archive status. `archiveBytesUsed` is the message backup's
 * own size; the host figure is the worker's last sample of every managed storage
 * root, with its age.
 */
export const renderArchiveStatus = (
  t: ArchiveText,
  status: ArchiveStatus,
  archiveBytesUsed: number | undefined,
  now: number,
): ArchivePanel => {
  const unknown = t.t('replies:archive.value_unknown');
  return {
    embeds: [
      {
        title: t.t('replies:archive.status_title'),
        description: [
          t.t('replies:archive.status_backup', { value: fullBackupLine(t, status, now) }),
          t.t('replies:archive.status_periodic', { value: periodicLine(t, status, now) }),
          ...(isActiveBackup(status.fullBackup) ? [t.t('replies:archive.periodic_paused')] : []),
          t.t('replies:archive.status_coverage_row', { value: coverageLine(t, status) }),
          t.t('replies:archive.status_live', {
            continuous:
              status.continuity === undefined
                ? unknown
                : archiveDuration(t, now - status.continuity.continuousSince),
            pending: archiveNumber(status.inbox.pending),
            dead: archiveNumber(status.inbox.dead),
          }),
          t.t('replies:archive.status_capacity', {
            archive: archiveBytesUsed === undefined ? unknown : archiveBytes(archiveBytesUsed),
            host:
              status.host === undefined
                ? unknown
                : t.t('replies:archive.status_capacity_host', {
                    usage: archiveBytesOf(status.host.usedBytes, status.host.budgetBytes),
                    measured: archiveTime(status.host.measuredAt, 'R'),
                  }),
          }),
        ].join('\n'),
        color: ARCHIVE_COLORS.running,
        timestamp: new Date(now).toISOString(),
      },
    ],
    components: archiveButtons([
      { action: { kind: 'status' }, label: t.t('replies:archive.button_refresh') },
      {
        action: { kind: 'gaps', origin: { kind: 'status' }, page: 1 },
        label: t.t('replies:archive.button_gaps'),
      },
      { action: { kind: 'records' }, label: t.t('replies:archive.button_records') },
    ]),
  };
};

/** `/archive schedule` reply; `changed` marks the settings this command altered. */
export const renderArchiveSchedule = (
  t: ArchiveText,
  schedule: ArchiveSchedule,
  input: {
    readonly changed: { readonly enabled: boolean; readonly interval: boolean };
    readonly requested: boolean;
    readonly backupActive: boolean;
  },
): ArchivePanel => {
  const marker = t.t('replies:archive.schedule_changed_marker');
  const note = !input.requested
    ? undefined
    : !input.changed.enabled && !input.changed.interval
      ? 'replies:archive.schedule_note_unchanged'
      : input.changed.enabled && !schedule.enabled
        ? 'replies:archive.schedule_note_disabled'
        : 'replies:archive.schedule_note_changed';
  return {
    embeds: [
      {
        title: t.t('replies:archive.schedule_title'),
        description: [
          t.t('replies:archive.schedule_state', {
            state: t.t(
              schedule.enabled
                ? 'replies:archive.schedule_enabled'
                : 'replies:archive.schedule_disabled',
            ),
            marker: input.changed.enabled ? marker : '',
          }),
          t.t('replies:archive.schedule_interval', {
            minutes: archiveNumber(schedule.intervalMs / 60_000),
            marker: input.changed.interval ? marker : '',
          }),
          t.t('replies:archive.schedule_next', {
            next:
              !schedule.enabled || schedule.nextRunAt === null
                ? t.t('replies:archive.value_none')
                : schedule.running
                  ? t.t('replies:archive.schedule_next_after_pass')
                  : archiveTime(schedule.nextRunAt),
          }),
          ...(note === undefined
            ? []
            : [t.t('replies:archive.schedule_note', { note: t.t(note) })]),
          ...(input.backupActive ? [t.t('replies:archive.periodic_paused')] : []),
        ].join('\n'),
        color: schedule.enabled ? ARCHIVE_COLORS.running : ARCHIVE_COLORS.stopped,
      },
    ],
    components: [],
  };
};
