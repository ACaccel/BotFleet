import { Routes, type Client, type SendableChannels } from 'discord.js';
import { isArchiveTerminalStatus } from '../../../core/archive/types';
import type { ArchiveProgressSnapshot } from '../../../core/archive/progress';
import type { ArchiveControlRepo } from '../../../persistence/repositories/archive-control.repo';
import type { ArchiveScheduleRepo } from '../../../persistence/repositories/archive-schedule.repo';
import type { ArchiveText } from '../../../application/archive/panel-format';
import type { ArchiveNoticeSlot, ArchivePeriodicSummary } from '../../../core/archive/schedule';
import {
  renderArchiveBackupPanel,
  renderArchiveInvalidRequestNotice,
  renderArchivePeriodicSummary,
  renderArchiveScheduleNotice,
  type ArchivePanel,
} from '../../../application/archive/panel';
import { withArchivePublicMessageLock } from '../../../application/archive/public-message';

/**
 * Discord errors retrying cannot fix: the message or channel is gone (10008,
 * 10003) or the bot lost access to it (50001, 50013).
 */
const PERMANENT_DISCORD_CODES = new Set([10003, 10008, 50001, 50013]);
export const isPermanentDiscordFailure = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof error.code === 'number' &&
  PERMANENT_DISCORD_CODES.has(error.code);
/** Failed notice sends wait one minute, doubling up to one hour. */
const NOTICE_RETRY_BASE_MS = 60_000;
const NOTICE_RETRY_MAX_MS = 3_600_000;

/**
 * `released`: Discord refused the panel permanently, so it was detached and is
 * not posted again; the result stays available in `/archive status`.
 */
export type ArchivePanelDelivery = 'delivered' | 'skipped' | 'released';

/** The job records a backup panel follows, scoped to one guild. */
export type ArchiveBackupPanelStore = Pick<
  ArchiveControlRepo,
  'findFullBackup' | 'releasePanel' | 'markPanelDelivered'
>;

/** Publishes a full backup's progress or result to the panel that follows it. */
export interface ArchiveBackupPanelPublisher {
  publish(jobId: string, snapshot: ArchiveProgressSnapshot): Promise<ArchivePanelDelivery>;
}

/** Builds one guild's publisher; the archive worker receives it from its composition root. */
export type ArchiveBackupPublisherFactory = (
  jobs: ArchiveBackupPanelStore,
) => ArchiveBackupPanelPublisher;

/**
 * Edits the panel that follows a full backup. A detail page an operator opened is
 * left alone; returning to the progress page renders the current state.
 */
class ArchiveBackupNotifier implements ArchiveBackupPanelPublisher {
  public constructor(
    private readonly options: {
      readonly client: Client;
      readonly translator: ArchiveText;
      readonly jobs: ArchiveBackupPanelStore;
    },
  ) {}

  /** Transient delivery failures propagate to the caller, which retries them. */
  public async publish(
    jobId: string,
    snapshot: ArchiveProgressSnapshot,
  ): Promise<ArchivePanelDelivery> {
    const { client, translator, jobs } = this.options;
    const initial = await jobs.findFullBackup(jobId);
    const panel = initial?.notification;
    if (initial === undefined || panel?.messageId === undefined) return 'skipped';
    const messageId = panel.messageId;
    return withArchivePublicMessageLock(panel.channelId, messageId, async () => {
      // The operator may have moved or paged the panel since the first read.
      const job = await jobs.findFullBackup(jobId);
      const current = job?.notification;
      if (
        job === undefined ||
        current === undefined ||
        current.messageId !== messageId ||
        current.channelId !== panel.channelId
      )
        return 'skipped';
      if (current.view !== 'gaps') {
        const rendered = renderArchiveBackupPanel(translator, job, snapshot, {
          now: Date.now(),
          latest: true,
        });
        try {
          await client.rest.patch(Routes.channelMessage(current.channelId, messageId), {
            body: {
              content: '',
              embeds: rendered.embeds,
              components: rendered.components,
              allowed_mentions: { parse: [] },
            },
          });
        } catch (error) {
          if (!isPermanentDiscordFailure(error)) throw error;
          await jobs.releasePanel(jobId, messageId);
          return 'released';
        }
      }
      if (isArchiveTerminalStatus(job.status))
        await jobs.markPanelDelivered(jobId, messageId, job.status);
      return current.view === 'gaps' ? 'skipped' : 'delivered';
    });
  }
}

/** The worker's notifier factory: one publisher per guild over a shared client and translator. */
export const archiveBackupNotifiers =
  (client: Client, translator: ArchiveText): ArchiveBackupPublisherFactory =>
  (jobs) =>
    new ArchiveBackupNotifier({ client, translator, jobs });

/** What happened to the pending debug-channel notice. */
export type ArchiveNoticeDelivery =
  | { readonly kind: 'none' }
  | { readonly kind: 'sent' }
  | { readonly kind: 'deferred'; readonly error: unknown; readonly retryAt: number }
  | { readonly kind: 'abandoned'; readonly error: unknown };

/** The stored notice of a slot and how it renders. */
const pendingNotice = async (
  schedule: ArchiveScheduleRepo,
  slot: ArchiveNoticeSlot,
  translator: ArchiveText,
): Promise<
  | {
      readonly notice: {
        readonly createdAt: number;
        readonly deliveredAt?: number;
        readonly abandonedAt?: number;
        readonly attempts?: number;
        readonly retryAt?: number;
      };
      readonly render: () => ArchivePanel;
    }
  | undefined
> => {
  if (slot === 'schedule') {
    const current = await schedule.read();
    const notice = current.notice;
    return notice === undefined
      ? undefined
      : {
          notice,
          render: () => renderArchiveScheduleNotice(translator, notice, current.nextRunAt),
        };
  }
  const notice = (await schedule.readInvalidRequests()).notice;
  return notice === undefined
    ? undefined
    : { notice, render: () => renderArchiveInvalidRequestNotice(translator, notice) };
};

/**
 * Sends a slot's pending notice (periodic health by default) to the debug channel,
 * mentioning `mentions` (the bot's admins). Delivery is at least once: a crash
 * between the send and its record can repeat it. A failed send waits with a capped
 * backoff; a permanent refusal is recorded and never retried.
 */
export const deliverArchiveScheduleNotice = async (
  schedule: ArchiveScheduleRepo,
  channel: SendableChannels | undefined,
  translator: ArchiveText,
  now = Date.now(),
  slot: ArchiveNoticeSlot = 'schedule',
  mentions: readonly string[] = [],
): Promise<ArchiveNoticeDelivery> => {
  const pending = await pendingNotice(schedule, slot, translator);
  const notice = pending?.notice;
  if (
    pending === undefined ||
    notice === undefined ||
    notice.deliveredAt !== undefined ||
    notice.abandonedAt !== undefined ||
    (notice.retryAt ?? 0) > now ||
    channel === undefined
  )
    return { kind: 'none' };
  const panel = pending.render();
  try {
    await channel.send({
      ...(mentions.length === 0 ? {} : { content: mentions.map((id) => `<@${id}>`).join(' ') }),
      embeds: panel.embeds,
      allowedMentions: { parse: [], users: [...mentions] },
    });
  } catch (error) {
    if (isPermanentDiscordFailure(error)) {
      await schedule.abandonNotice(notice.createdAt, slot);
      return { kind: 'abandoned', error };
    }
    const attempts = (notice.attempts ?? 0) + 1;
    const retryAt =
      now + Math.min(NOTICE_RETRY_MAX_MS, NOTICE_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 6));
    await schedule.deferNotice(notice.createdAt, attempts, retryAt, slot);
    return { kind: 'deferred', error, retryAt };
  }
  await schedule.markNoticeDelivered(notice.createdAt, slot);
  return { kind: 'sent' };
};

/** What happened to a pass summary; `deleteError` is set when the replaced one remains. */
export type ArchiveSummaryDelivery =
  | { readonly kind: 'none' }
  | { readonly kind: 'sent'; readonly deleteError?: unknown }
  | { readonly kind: 'edited' };

/**
 * Posts a panel when a pass starts, then edits that message through completion.
 * A new pass replaces the previous panel. A failed send keeps the old message;
 * a missing current message is recreated, while other edit failures propagate.
 */
export const publishArchivePeriodicSummary = async (
  schedule: Pick<ArchiveScheduleRepo, 'read' | 'replaceSummary'>,
  channel: SendableChannels | undefined,
  rest: Pick<Client['rest'], 'delete' | 'patch'>,
  translator: ArchiveText,
  summary: ArchivePeriodicSummary,
): Promise<ArchiveSummaryDelivery> => {
  if (channel === undefined) return { kind: 'none' };
  const { nextRunAt, summary: current } = await schedule.read();
  const panel = renderArchivePeriodicSummary(translator, summary, nextRunAt);
  if (current?.startedAt === summary.startedAt) {
    try {
      await rest.patch(Routes.channelMessage(current.channelId, current.messageId), {
        body: { embeds: panel.embeds, allowed_mentions: { parse: [] } },
      });
      return { kind: 'edited' };
    } catch (error) {
      // Recreate only a deleted message; lost permissions must not cause repeated sends.
      if ((error as { code?: unknown } | null)?.code !== 10008) throw error;
    }
  }
  const sent = await channel.send({ embeds: panel.embeds, allowedMentions: { parse: [] } });
  const previous = await schedule.replaceSummary({
    channelId: sent.channelId,
    messageId: sent.id,
    startedAt: summary.startedAt,
  });
  if (previous === undefined || previous.messageId === sent.id) return { kind: 'sent' };
  try {
    await rest.delete(Routes.channelMessage(previous.channelId, previous.messageId));
  } catch (error) {
    if (!isPermanentDiscordFailure(error)) return { kind: 'sent', deleteError: error };
  }
  return { kind: 'sent' };
};
