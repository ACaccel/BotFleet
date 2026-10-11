import type { ButtonInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import type { ArchiveControlError } from '../../../core/errors';
import type { Result } from '../../../core/result';
import type { ArchivePanel } from '../../../application/archive/panel';
import { renderArchiveNotice } from '../../../application/archive/panel';
import type { ArchivePanelAction } from '../../../application/archive/panel-ids';
import type { ArchiveAccess } from '../../commands/archive-shared/access';
import {
  archiveConfirmView,
  archiveGapView,
  archiveJobView,
  archiveRecordsView,
  archiveStatusView,
  archiveText,
} from '../../commands/archive-shared/views';

/** A rejected control request ends the press; `archiveFailure` answers it privately. */
const accepted = async <T>(result: Promise<Result<T, ArchiveControlError>>): Promise<T> => {
  const settled = await result;
  if (!settled.ok) throw settled.error;
  return settled.value;
};

/**
 * Applies one panel button and returns the page that replaces the clicked message.
 * The caller holds the message's edit lock, so a full backup's progress update
 * cannot interleave with a page switch.
 */
export const applyArchiveAction = async (
  interaction: ButtonInteraction,
  bot: BaseBot,
  access: ArchiveAccess,
  action: ArchivePanelAction,
): Promise<ArchivePanel> => {
  const { control } = access;
  const panel = { channelId: interaction.channelId, messageId: interaction.message.id };
  const actor = { ...panel, userId: interaction.user.id };
  switch (action.kind) {
    case 'start':
      return archiveJobView(bot, access, await accepted(control.confirm(action.token, actor)));
    case 'abort':
      await accepted(control.cancelConfirmation(action.token, actor));
      return renderArchiveNotice(archiveText(bot), 'replies:archive.confirm_cancelled');
    case 'stop':
      return archiveJobView(bot, access, await accepted(control.stop(action.jobId)));
    case 'resume':
      return archiveJobView(bot, access, await accepted(control.resume(action.jobId, panel)));
    case 'restart':
      // The old backup's result must not later overwrite this confirmation.
      await accepted(control.prepareRestart(action.jobId, panel));
      return archiveConfirmView(bot, access, actor, true);
    case 'progress': {
      const job = await accepted(control.job(action.jobId));
      await control.setPanel(job.jobId, { ...panel, view: 'progress' });
      return archiveJobView(bot, access, await accepted(control.job(job.jobId)));
    }
    case 'gaps':
      if (action.origin.kind === 'job') {
        const job = await accepted(control.job(action.origin.jobId));
        await control.setPanel(job.jobId, { ...panel, view: 'gaps' });
      }
      return archiveGapView(bot, access, action.origin, action.page);
    case 'status':
      return archiveStatusView(bot, access);
    case 'records':
      return archiveRecordsView(bot, access);
    default: {
      const unreachable: never = action;
      throw new TypeError(`Unknown archive panel action ${JSON.stringify(unreachable)}`);
    }
  }
};
