import { type ButtonInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { ButtonHandler } from '../button-handler';
import { ArchiveAccessError, requireArchiveAccess } from '../../commands/archive/access';
import { archiveJobReply } from '../../commands/archive/presentation';
import { archivePublicReply } from '../../commands/archive/public-reply';
import { archiveFailure, publishArchiveReply } from '../../commands/archive/replies';
import { bindTranslator } from '../../../core/i18n';
import { archiveScanReply } from './scan-panel';
import { executeArchivePublicJobControl } from './job-control';
import {
  archivePanelButton,
  button,
  present,
  rows,
} from '../../commands/archive/presentation-common';

const panelPage = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100_000)
    throw new ArchiveAccessError('replies:archive.navigation_stale');
  return page;
};

/** Recover shared details using durable identity after interaction expiry. */
export default class archive_panel extends ButtonHandler {
  public override async execute(interaction: ButtonInteraction, bot: BaseBot): Promise<void> {
    await interaction.deferUpdate();
    try {
      const scanMatch =
        /^archive_panel\|scan\|([A-Za-z0-9:_-]{1,160})(?:\|p\|([1-9]\d{0,5}))?$/.exec(
          interaction.customId,
        );
      const match = /^archive_panel\|([A-Za-z0-9:_-]{1,160})(?:\|p\|([1-9]\d{0,5}))?$/.exec(
        interaction.customId,
      );
      const detailMatch =
        /^archive_panel\|([A-Za-z0-9:_-]{1,160})\|(changes|technical|cancel)$/.exec(
          interaction.customId,
        );
      if (
        match?.[1] === undefined &&
        scanMatch?.[1] === undefined &&
        detailMatch?.[1] === undefined
      )
        throw new ArchiveAccessError('replies:archive.navigation_stale');
      const access = await requireArchiveAccess(interaction, bot);
      const { control } = access;
      const t = bindTranslator(bot.translator);
      if (detailMatch?.[1] !== undefined) {
        await executeArchivePublicJobControl(
          interaction,
          bot,
          access,
          detailMatch[1],
          detailMatch[2] === 'cancel'
            ? 'cancel'
            : detailMatch[2] === 'changes'
              ? 'changes'
              : 'technical',
        );
        return;
      }
      if (scanMatch?.[1] !== undefined) {
        await publishArchiveReply(
          interaction,
          archivePublicReply(
            await archiveScanReply(
              interaction,
              bot,
              control,
              scanMatch[1],
              panelPage(scanMatch[2]),
            ),
            { scanId: scanMatch[1] },
          ),
          bot,
          access,
        );
        return;
      }
      const job = await control.status(match![1]!);
      const page = panelPage(match![2]);
      const details = page === null ? undefined : await control.progressDetails(job.jobId, page, 1);
      const reply = await archiveJobReply(
        job,
        bot,
        control,
        page,
        {
          userId: interaction.user.id,
          channelId: interaction.channelId,
          messageId: interaction.message.id,
        },
        [],
        details,
      );
      if (page !== null) {
        reply.components = rows(
          [
            archivePanelButton(job.jobId, t('replies:archive.view_summary')),
            ...(page > 1
              ? [
                  button(
                    `archive_panel|${job.jobId}|p|${page - 1}`,
                    t('replies:archive.page_previous'),
                  ),
                ]
              : []),
            ...(details?.hasNext && page < 100_000
              ? [button(`archive_panel|${job.jobId}|p|${page + 1}`, t('replies:archive.page_next'))]
              : []),
          ].filter(present),
        );
      }
      await publishArchiveReply(
        interaction,
        archivePublicReply(reply, { jobId: job.jobId }),
        bot,
        access,
      );
    } catch (error) {
      await archiveFailure(interaction, bot, error);
    }
  }
}
