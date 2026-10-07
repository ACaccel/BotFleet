import type { ButtonInteraction, InteractionReplyOptions } from 'discord.js';
import type { BaseBot } from '@bot';
import { sanitizeArchiveProgress } from '../../../core/archive/progress';
import { bindTranslator } from '../../../core/i18n';
import type { ArchiveControlService } from '../../../infra/archive/control';
import { ArchiveAccessError } from '../../commands/archive/access';
import { renderArchiveStatus } from '../../commands/archive/progress';
import { button, present, rows } from '../../commands/archive/presentation-common';

/** The retained current scan must match the notification that opened this panel. */
export const archiveScanReply = async (
  interaction: ButtonInteraction,
  bot: BaseBot,
  control: ArchiveControlService,
  scanId: string,
  page: number | null,
): Promise<InteractionReplyOptions> => {
  const t = bindTranslator(bot.translator);
  const periodic = await control.periodicStatus();
  if (periodic?.['runId'] !== scanId)
    return { content: t('replies:archive.periodic_unavailable'), components: [] };
  const progress = sanitizeArchiveProgress(
    periodic['progress'] ?? {
      work: 'periodic',
      phase: 'history',
      state: periodic['status'],
      scanId,
      messageCountQuality: 'lower-bound',
      ...(typeof periodic['cutoff'] === 'number' && periodic['cutoff'] > 0
        ? { cutoff: new Date(periodic['cutoff']).toISOString() }
        : {}),
    },
  );
  if (progress === undefined) throw new ArchiveAccessError('replies:archive.navigation_stale');
  const details = page === null ? undefined : await control.progressDetails(scanId, page, 1);
  const content = await renderArchiveStatus(progress, bot, control, scanId, page, [], {
    guild: interaction.guild,
    guildId: interaction.guildId ?? '',
    loadedDetails: details,
  });
  const buttons = [
    button(`archive_panel|scan|${scanId}`, t('replies:archive.panel_refresh')),
    ...(page === null
      ? [button(`archive_panel|scan|${scanId}|p|1`, t('replies:archive.public_issues'))]
      : []),
    ...(page !== null && page > 1
      ? [button(`archive_panel|scan|${scanId}|p|${page - 1}`, t('replies:archive.page_previous'))]
      : []),
    ...(details?.hasNext && page !== null && page < 100_000
      ? [button(`archive_panel|scan|${scanId}|p|${page + 1}`, t('replies:archive.page_next'))]
      : []),
  ];
  return { content, components: rows(buttons.filter(present)) };
};
