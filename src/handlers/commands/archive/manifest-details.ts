import type { InteractionReplyOptions } from 'discord.js';
import type { BaseBot } from '@bot';
import { bindTranslator } from '../../../core/i18n';
import type { ArchiveControlService } from '../../../infra/archive/control';
import type { ArchiveBrowsePage } from './navigation';
import { manifestOptions } from './manifest-page-common';
import { renderGroups } from './manifest-groups';
import { renderOperations } from './manifest-operations';

/** Legacy detail links reopen the same bounded change view. */
export const manifestDetailsReply = async (
  runId: string,
  bot: BaseBot,
  control: ArchiveControlService,
  actor: { userId: string; channelId: string; messageId?: string },
  page: ArchiveBrowsePage,
): Promise<InteractionReplyOptions> => {
  const t = bindTranslator(bot.translator);
  const { sequence: _sequence, detailPage: _detailPage, returnTo: _returnTo, ...position } = page;
  const current = { ...position, view: 'changes' as const };
  const report = await control.manifest(runId, manifestOptions(current));
  const navigationActor = { ...actor, guildId: report.run.guildId };
  const filteredTotal =
    report.summary.status === 'available'
      ? page.category === undefined
        ? report.summary.totalOperations
        : (report.summary.categories.find((entry) => entry.category === page.category)
            ?.operations ?? 0)
      : undefined;
  if (
    page.afterGroup !== undefined ||
    page.beforeGroup !== undefined ||
    (page.sourceId === undefined &&
      page.afterSequence === undefined &&
      page.beforeSequence === undefined &&
      (filteredTotal === undefined || filteredTotal > 10))
  )
    return renderGroups(runId, report, bot, control, navigationActor, current, t);
  return renderOperations(runId, report, bot, navigationActor, current, t);
};
