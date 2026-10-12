import {
  ButtonStyle,
  ComponentType,
  escapeMarkdown,
  type APIActionRowComponent,
  type APIButtonComponentWithCustomId,
  type APIEmbed,
} from 'discord.js';
import {
  isResumableBackup,
  type ArchiveCoverage,
  type ArchiveFullBackupJob,
  type ArchiveGapChannel,
  type ArchiveJob,
  type ArchivePeriodicRecord,
} from '../../core/archive/types';
import type { ArchiveActivityStep, ArchiveProgressSnapshot } from '../../core/archive/progress';
import type { ArchiveScheduleNotice } from '../../core/archive/schedule';
import { archivePanelId, type ArchivePanelAction, type ArchivePanelOrigin } from './panel-ids';
import {
  ARCHIVE_COLORS,
  archiveChannelName,
  archiveCount,
  archiveDuration,
  archiveNumber,
  archiveReason,
  archiveTime,
  type ArchiveText,
} from './panel-format';

/** A public panel message: embeds plus at most one row of five buttons. */
export interface ArchivePanel {
  readonly embeds: APIEmbed[];
  readonly components: APIActionRowComponent<APIButtonComponentWithCustomId>[];
}
interface PanelButton {
  readonly action: ArchivePanelAction;
  readonly label: string;
  readonly style?: ButtonStyle.Primary | ButtonStyle.Secondary | ButtonStyle.Danger;
  readonly disabled?: boolean;
}

export const archiveButtons = (
  buttons: readonly PanelButton[],
): APIActionRowComponent<APIButtonComponentWithCustomId>[] =>
  buttons.length === 0
    ? []
    : [
        {
          type: ComponentType.ActionRow,
          components: buttons.slice(0, 5).map((button) => ({
            type: ComponentType.Button,
            custom_id: archivePanelId(button.action),
            label: button.label,
            style: button.style ?? ButtonStyle.Secondary,
            ...(button.disabled === true ? { disabled: true } : {}),
          })),
        },
      ];

/** Display state of a full backup; `gaps` is complete with only known gaps left. */
export type ArchiveBackupState =
  | 'queued'
  | 'running'
  | 'stopping'
  | 'complete'
  | 'gaps'
  | 'stopped'
  | 'failed';

const hasGaps = (job: ArchiveJob): boolean => (job.result?.gaps?.length ?? 0) > 0;

export const archiveBackupState = (job: ArchiveFullBackupJob): ArchiveBackupState => {
  switch (job.status) {
    case 'queued':
      return 'queued';
    case 'running':
      return job.cancelRequested ? 'stopping' : 'running';
    case 'complete':
      return hasGaps(job) ? 'gaps' : 'complete';
    case 'cancelled':
      return 'stopped';
    case 'partial':
    case 'failed':
      return 'failed';
    default: {
      const unreachable: never = job.status;
      throw new TypeError(`Unknown archive job status ${String(unreachable)}`);
    }
  }
};
const STATE_COLORS: Readonly<Record<ArchiveBackupState, number>> = {
  queued: ARCHIVE_COLORS.running,
  running: ARCHIVE_COLORS.running,
  stopping: ARCHIVE_COLORS.running,
  complete: ARCHIVE_COLORS.complete,
  gaps: ARCHIVE_COLORS.gaps,
  stopped: ARCHIVE_COLORS.stopped,
  failed: ARCHIVE_COLORS.failed,
};
const STEP_KEYS: Readonly<Record<ArchiveActivityStep, string>> = {
  fetching: 'replies:archive.step_fetching',
  processing: 'replies:archive.step_processing',
  writing: 'replies:archive.step_writing',
  reactions: 'replies:archive.step_reactions',
  checkpoint: 'replies:archive.step_checkpoint',
  waiting: 'replies:archive.step_waiting',
  queued: 'replies:archive.step_queued',
  draining: 'replies:archive.step_draining',
};

const activityLine = (t: ArchiveText, snapshot: ArchiveProgressSnapshot): string | undefined => {
  const [first] = snapshot.activities;
  if (first === undefined) return undefined;
  const sources = snapshot.activities
    .map((activity) =>
      t.t('replies:archive.activity_source', {
        channel: archiveChannelName(t, activity.name),
        // Full scans fetch 100 messages per page.
        page: archiveNumber(Math.floor(activity.scanned / 100) + 1),
      }),
    )
    .join(t.t('replies:archive.list_separator'));
  return t.t('replies:archive.backup_activity', {
    sources: snapshot.activityCount > snapshot.activities.length ? `${sources}…` : sources,
    step: t.t(STEP_KEYS[first.step]),
  });
};

/** Speed over the recent window, in messages per second. */
const recentRate = (snapshot: ArchiveProgressSnapshot): number | undefined => {
  const recent = snapshot.recentThroughput;
  return recent === undefined || recent.windowMs < 1000
    ? undefined
    : recent.messages / (recent.windowMs / 1000);
};

/** Body lines of the full-backup panel. */
const archiveBackupLines = (
  t: ArchiveText,
  job: ArchiveFullBackupJob,
  snapshot: ArchiveProgressSnapshot,
  now: number,
): string[] => {
  const state = archiveBackupState(job);
  const active = state === 'running' || state === 'stopping';
  const messages = snapshot.messages;
  const rate = active ? recentRate(snapshot) : undefined;
  const unknown = t.t('replies:archive.value_unknown');
  const lines = [
    ...(active ? [activityLine(t, snapshot)] : []),
    t.t('replies:archive.backup_channels', {
      completed: archiveNumber(snapshot.sources.completed),
      total: snapshot.sources.total > 0 ? archiveNumber(snapshot.sources.total) : unknown,
      gaps: archiveCount(t, 'count_gaps', snapshot.gapCount),
    }),
    t.t('replies:archive.backup_messages', {
      scanned: archiveNumber(messages.scanned),
      written: archiveNumber(messages.inserted + messages.updated),
      unchanged: archiveNumber(messages.unchanged),
    }),
    t.t('replies:archive.backup_reactions', {
      completed: archiveCount(t, 'count_messages', snapshot.reactions.completed),
      stale: archiveNumber(snapshot.reactions.stale ?? 0),
    }),
    ...(rate === undefined
      ? []
      : [t.t('replies:archive.backup_speed', { rate: archiveNumber(rate) })]),
    t.t('replies:archive.backup_timing', {
      cutoff: Number.isSafeInteger(job.options.cutoff) ? archiveTime(job.options.cutoff) : unknown,
      // Wall time since the job first started, so a restart mid-backup does not reset it.
      elapsed: archiveDuration(
        t,
        Math.max(0, (job.finishedAt ?? now) - (job.startedAt ?? job.createdAt)),
      ),
      started: archiveTime(job.startedAt ?? job.createdAt),
      updated: archiveTime(job.finishedAt ?? now, 'T'),
    }),
    ...(state === 'failed'
      ? [
          t.t('replies:archive.backup_failure', {
            reason: archiveReason(t, job.result?.reason ?? snapshot.reason),
          }),
        ]
      : []),
  ];
  return lines.filter((line): line is string => line !== undefined);
};

/**
 * The panel that follows a full backup. A finished backup keeps only the gap
 * details, plus **Resume** when it is stopped or failed and still the newest one,
 * and **Start over** when the operator opened it with `/archive backup`.
 */
export const renderArchiveBackupPanel = (
  t: ArchiveText,
  job: ArchiveFullBackupJob,
  snapshot: ArchiveProgressSnapshot,
  options: { readonly now: number; readonly latest: boolean; readonly offerRestart?: boolean },
): ArchivePanel => {
  const state = archiveBackupState(job);
  const gaps: PanelButton = {
    action: { kind: 'gaps', origin: { kind: 'job', jobId: job.jobId }, page: 1 },
    label: t.t('replies:archive.button_gaps'),
  };
  const resumable = options.latest && isResumableBackup(job);
  const buttons: PanelButton[] =
    state === 'queued' || state === 'running'
      ? [
          {
            action: { kind: 'stop', jobId: job.jobId },
            label: t.t('replies:archive.button_stop'),
            style: ButtonStyle.Danger,
          },
          gaps,
        ]
      : [
          ...(resumable
            ? [
                {
                  action: { kind: 'resume', jobId: job.jobId },
                  label: t.t('replies:archive.button_resume'),
                  style: ButtonStyle.Primary,
                } as const,
              ]
            : []),
          ...(resumable && options.offerRestart === true
            ? [
                {
                  action: { kind: 'restart', jobId: job.jobId },
                  label: t.t('replies:archive.button_restart'),
                } as const,
              ]
            : []),
          gaps,
        ];
  return {
    embeds: [
      {
        title: t.t('replies:archive.backup_title', {
          state: t.t(`replies:archive.backup_state_${state}`),
        }),
        description: archiveBackupLines(t, job, snapshot, options.now).join('\n'),
        color: STATE_COLORS[state],
      },
    ],
    components: archiveButtons(buttons),
  };
};

/** Shown once before a full backup starts or starts over with a new cutoff. */
export const renderArchiveConfirmPanel = (
  t: ArchiveText,
  input: {
    readonly guildName: string;
    readonly coverage?: ArchiveCoverage;
    readonly restart: boolean;
    readonly token: string;
    readonly expiresAt: number;
    readonly userId: string;
  },
): ArchivePanel => {
  const gaps = input.coverage
    ? input.coverage.gaps.denied + input.coverage.gaps.deleted + input.coverage.gaps.unknown
    : 0;
  return {
    embeds: [
      {
        title: t.t(
          input.restart ? 'replies:archive.confirm_restart_title' : 'replies:archive.confirm_title',
        ),
        description: [
          t.t('replies:archive.confirm_guild', { guild: escapeMarkdown(input.guildName) }),
          input.coverage === undefined || input.coverage.readable + gaps === 0
            ? t.t('replies:archive.confirm_scope_unknown')
            : t.t('replies:archive.confirm_scope', {
                readable: archiveCount(t, 'count_readable_channels', input.coverage.readable),
                gaps: archiveCount(t, 'count_gaps', gaps),
              }),
          ...(input.restart ? [t.t('replies:archive.confirm_restart_effect')] : []),
          t.t('replies:archive.confirm_effect'),
          t.t('replies:archive.confirm_binding', {
            user: `<@${input.userId}>`,
            expires: archiveTime(input.expiresAt, 'R'),
          }),
        ].join('\n'),
        color: ARCHIVE_COLORS.running,
      },
    ],
    components: archiveButtons([
      {
        action: { kind: 'start', token: input.token },
        label: t.t('replies:archive.button_start'),
        style: ButtonStyle.Primary,
      },
      {
        action: { kind: 'abort', token: input.token },
        label: t.t('replies:archive.button_cancel'),
      },
    ]),
  };
};

/** A confirmation that was cancelled, expired or replaced; no buttons remain. */
export const renderArchiveNotice = (t: ArchiveText, key: string): ArchivePanel => ({
  embeds: [{ description: t.t(key), color: ARCHIVE_COLORS.stopped }],
  components: [],
});

const GAP_KEYS: Readonly<Record<ArchiveGapChannel['access'], string>> = {
  denied: 'replies:archive.gap_denied',
  deleted: 'replies:archive.gap_deleted',
  unknown: 'replies:archive.gap_unknown',
};

/** Sources the bot cannot back up, grouped by reason, ten per page. */
export const renderArchiveGapPage = (
  t: ArchiveText,
  page: { rows: readonly ArchiveGapChannel[]; total: number; page: number; pages: number },
  origin: ArchivePanelOrigin,
): ArchivePanel => {
  const lines: string[] = [];
  let group: ArchiveGapChannel['access'] | undefined;
  for (const row of page.rows) {
    if (row.access !== group) {
      group = row.access;
      lines.push(`**${t.t(GAP_KEYS[row.access])}**`);
    }
    lines.push(`- ${archiveChannelName(t, row.name)}`);
  }
  return {
    embeds: [
      {
        title: t.t('replies:archive.gaps_title', {
          page: page.page,
          pages: page.pages,
          total: archiveCount(t, 'count_channels', page.total),
        }),
        description: lines.length === 0 ? t.t('replies:archive.gaps_none') : lines.join('\n'),
        color: ARCHIVE_COLORS.stopped,
      },
    ],
    components: archiveButtons([
      {
        action: { kind: 'gaps', origin, page: Math.max(1, page.page - 1) },
        label: t.t('replies:archive.button_previous'),
        disabled: page.page <= 1,
      },
      {
        action: { kind: 'gaps', origin, page: Math.min(page.pages, page.page + 1) },
        label: t.t('replies:archive.button_next'),
        disabled: page.page >= page.pages,
      },
      {
        action:
          origin.kind === 'status' ? { kind: 'status' } : { kind: 'progress', jobId: origin.jobId },
        label: t.t('replies:archive.button_back'),
      },
    ]),
  };
};

const periodicResultKey = (record: ArchivePeriodicRecord): string => {
  switch (record.status) {
    case 'complete':
      return hasGaps(record)
        ? 'replies:archive.record_periodic_gaps'
        : 'replies:archive.record_periodic_complete';
    case 'cancelled':
      return 'replies:archive.record_periodic_interrupted';
    case 'partial':
    case 'failed':
      return 'replies:archive.record_periodic_failed';
    default: {
      const unreachable: never = record.status;
      throw new TypeError(`Unknown periodic record status ${String(unreachable)}`);
    }
  }
};
const recordKind = (record: ArchiveJob): { kind: string; result: string } => {
  switch (record.command) {
    case 'full-backup':
      return {
        kind: 'replies:archive.record_kind_full_backup',
        result: `replies:archive.backup_state_${archiveBackupState(record)}`,
      };
    case 'periodic':
      return { kind: 'replies:archive.record_kind_periodic', result: periodicResultKey(record) };
    default: {
      const unreachable: never = record;
      throw new TypeError(`Unknown archive record ${JSON.stringify(unreachable)}`);
    }
  }
};

/** The retained full-backup and periodic records. */
export const renderArchiveRecords = (
  t: ArchiveText,
  records: readonly ArchiveJob[],
  now: number,
): ArchivePanel => ({
  embeds: [
    {
      title: t.t('replies:archive.records_title'),
      description:
        records.length === 0
          ? t.t('replies:archive.records_none')
          : records
              .map((record) => {
                const labels = recordKind(record);
                return t.t('replies:archive.record_row', {
                  kind: t.t(labels.kind),
                  result: t.t(labels.result),
                  started: archiveTime(record.startedAt ?? record.createdAt),
                  duration: archiveDuration(
                    t,
                    (record.finishedAt ?? now) - (record.startedAt ?? record.createdAt),
                  ),
                });
              })
              .join('\n'),
      color: ARCHIVE_COLORS.stopped,
    },
  ],
  components: archiveButtons([
    { action: { kind: 'status' }, label: t.t('replies:archive.button_back') },
  ]),
});

/** The debug-channel message for repeated periodic failures or their recovery. */
export const renderArchiveScheduleNotice = (
  t: ArchiveText,
  notice: ArchiveScheduleNotice,
  nextRunAt: number | null,
): ArchivePanel => ({
  embeds: [
    notice.kind === 'failing'
      ? {
          title: t.t('replies:archive.notice_failing_title'),
          description: [
            t.t('replies:archive.notice_failing_count', { failures: notice.failures }),
            t.t('replies:archive.notice_failing_reason', {
              reason: archiveReason(t, notice.reason),
            }),
            nextRunAt === null
              ? t.t('replies:archive.notice_no_retry')
              : t.t('replies:archive.notice_next_retry', { next: archiveTime(nextRunAt, 'R') }),
          ].join('\n'),
          color: ARCHIVE_COLORS.failed,
        }
      : {
          title: t.t('replies:archive.notice_recovered_title'),
          description: t.t('replies:archive.notice_recovered_body'),
          color: ARCHIVE_COLORS.complete,
        },
  ],
  components: [],
});
