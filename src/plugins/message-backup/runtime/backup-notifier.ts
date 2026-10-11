import { Routes, type Client, type SendableChannels } from 'discord.js';
import { isArchiveTerminalStatus } from '../../../core/archive/types';
import type { ArchiveProgressSnapshot } from '../../../core/archive/progress';
import type { ArchiveControlRepo } from '../../../persistence/repositories/archive-control.repo';
import type { ArchiveScheduleRepo } from '../../../persistence/repositories/archive-schedule.repo';
import type { ArchiveText } from '../../../application/archive/panel-format';
import {
  renderArchiveBackupPanel,
  renderArchiveScheduleNotice,
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

/** What happened to the pending periodic-health notice. */
export type ArchiveNoticeDelivery =
  | { readonly kind: 'none' }
  | { readonly kind: 'sent' }
  | { readonly kind: 'deferred'; readonly error: unknown; readonly retryAt: number }
  | { readonly kind: 'abandoned'; readonly error: unknown };

/**
 * Sends a pending periodic-health notice to the debug channel. Delivery is at
 * least once: a crash between the send and its record can repeat it. A failed
 * send waits with a capped backoff; a permanent refusal is recorded and never
 * retried.
 */
export const deliverArchiveScheduleNotice = async (
  schedule: ArchiveScheduleRepo,
  channel: SendableChannels | undefined,
  translator: ArchiveText,
  now = Date.now(),
): Promise<ArchiveNoticeDelivery> => {
  const current = await schedule.read();
  const notice = current.notice;
  if (
    notice === undefined ||
    notice.deliveredAt !== undefined ||
    notice.abandonedAt !== undefined ||
    (notice.retryAt ?? 0) > now ||
    channel === undefined
  )
    return { kind: 'none' };
  const panel = renderArchiveScheduleNotice(translator, notice, current.nextRunAt);
  try {
    await channel.send({ embeds: panel.embeds, allowedMentions: { parse: [] } });
  } catch (error) {
    if (isPermanentDiscordFailure(error)) {
      await schedule.abandonNotice(notice.createdAt);
      return { kind: 'abandoned', error };
    }
    const attempts = (notice.attempts ?? 0) + 1;
    const retryAt =
      now + Math.min(NOTICE_RETRY_MAX_MS, NOTICE_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 6));
    await schedule.deferNotice(notice.createdAt, attempts, retryAt);
    return { kind: 'deferred', error, retryAt };
  }
  await schedule.markNoticeDelivered(notice.createdAt);
  return { kind: 'sent' };
};
