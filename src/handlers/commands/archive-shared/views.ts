import type { BaseBot } from '@bot';
import { bindTranslator } from '../../../core/i18n';
import type { ArchiveText } from '../../../application/archive/panel-format';
import { archiveJobProgress } from '../../../core/archive/progress';
import {
  isActiveBackup,
  isResumableBackup,
  type ArchiveFullBackupJob,
} from '../../../core/archive/types';
import type { ArchivePanelActor } from '../../../application/archive/control';
import {
  renderArchiveBackupPanel,
  renderArchiveConfirmPanel,
  renderArchiveGapPage,
  renderArchiveRecords,
  type ArchivePanel,
} from '../../../application/archive/panel';
import type { ArchivePanelOrigin } from '../../../application/archive/panel-ids';
import { renderArchiveStatus } from '../../../application/archive/panel-status';
import type { ArchiveAccess } from './access';

/** Renders with the bot's translator, or keys when it is not ready. */
export const archiveText = (bot: BaseBot): ArchiveText => ({ t: bindTranslator(bot.translator) });

/** A full backup's panel; **Resume** appears only on the newest backup. */
export const archiveJobView = async (
  bot: BaseBot,
  access: ArchiveAccess,
  job: ArchiveFullBackupJob,
  offerRestart = false,
): Promise<ArchivePanel> => {
  const latest = await access.control.latestFullBackup();
  return renderArchiveBackupPanel(archiveText(bot), job, archiveJobProgress(job), {
    now: Date.now(),
    latest: latest?.jobId === job.jobId,
    offerRestart,
  });
};

/** The single confirmation before a full backup starts, bound to this panel. */
export const archiveConfirmView = async (
  bot: BaseBot,
  access: ArchiveAccess,
  actor: ArchivePanelActor,
  restart: boolean,
): Promise<ArchivePanel> => {
  const [{ token, expiresAt }, coverage] = await Promise.all([
    access.control.requestConfirmation(actor),
    access.control.coverage(),
  ]);
  return renderArchiveConfirmPanel(archiveText(bot), {
    guildName: access.guildName,
    coverage,
    restart,
    token,
    expiresAt,
    userId: actor.userId,
  });
};

/**
 * `/archive backup`: an active backup moves its panel to this message; a stopped
 * or failed one offers resume or a fresh start; otherwise the confirmation.
 */
export const archiveBackupEntry = async (
  bot: BaseBot,
  access: ArchiveAccess,
  actor: ArchivePanelActor,
): Promise<ArchivePanel> => {
  const latest = await access.control.latestFullBackup();
  if (latest !== undefined && isActiveBackup(latest)) {
    await access.control.setPanel(latest.jobId, {
      channelId: actor.channelId,
      messageId: actor.messageId,
      view: 'progress',
    });
    return archiveJobView(bot, access, latest);
  }
  if (latest !== undefined && isResumableBackup(latest))
    return archiveJobView(bot, access, latest, true);
  return archiveConfirmView(bot, access, actor, false);
};

export const archiveStatusView = async (
  bot: BaseBot,
  access: ArchiveAccess,
): Promise<ArchivePanel> => {
  const [status, archiveBytes] = await Promise.all([
    access.control.status(),
    access.control.archiveBytes().catch((error: unknown) => {
      // The rest of the status stays useful; the size shows as unknown.
      bot.logger?.warn({ err: error, guildId: access.guildId }, 'Archive size unavailable');
      return undefined;
    }),
  ]);
  return renderArchiveStatus(archiveText(bot), status, archiveBytes, Date.now());
};

export const archiveGapView = async (
  bot: BaseBot,
  access: ArchiveAccess,
  origin: ArchivePanelOrigin,
  page: number,
): Promise<ArchivePanel> =>
  renderArchiveGapPage(archiveText(bot), await access.control.gapChannels(page), origin);

export const archiveRecordsView = async (
  bot: BaseBot,
  access: ArchiveAccess,
): Promise<ArchivePanel> =>
  renderArchiveRecords(archiveText(bot), await access.control.recentRecords(), Date.now());
