import type {
  ButtonInteraction,
  StringSelectMenuInteraction,
  InteractionReplyOptions,
} from 'discord.js';
import type { BaseBot } from '@bot';
import { bindTranslator } from '../../../core/i18n';
import type { ArchiveAccess } from './access';
import { ArchiveAccessError } from './access';
import { consumeArchiveDeletion, requestArchiveDeletion } from './delete-confirmation';
import { manageBack, manageButton } from './manage-common';
import { date, rows } from './presentation-common';
import { archivePublicReference } from './public-reply';
import { publishDeletedArchivePlan } from './deleted-plan-message';
import { publishArchiveJobDeletion } from './deleted-job-message';

export const archiveManageDeletion = async (
  action: string,
  id: string,
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  bot: BaseBot,
  access: ArchiveAccess,
): Promise<InteractionReplyOptions> => {
  const t = bindTranslator(bot.translator);
  const actor = {
    userId: interaction.user.id,
    guildId: access.guildId,
    channelId: interaction.channelId,
    messageId: interaction.message.id,
  };
  if (action === 'delete-confirm') {
    const confirmation = consumeArchiveDeletion(id, actor);
    let pending = false;
    if (confirmation.kind === 'job') {
      pending = (await access.control.deleteJob(confirmation.id)).pending;
      await publishArchiveJobDeletion(confirmation.id, pending, bot, access);
    } else {
      const reference = await archivePublicReference(access, { runId: confirmation.id });
      await access.control.deletePlan(confirmation.id);
      await publishDeletedArchivePlan(bot, reference);
    }
    return {
      content: t(`replies:archive.manage_${pending ? 'delete_pending' : 'deleted'}`),
      components: rows([manageBack(confirmation.kind === 'job' ? 'jobs' : 'plans', t)]),
    };
  }
  const kind = action === 'delete-job' ? 'job' : 'plan';
  let context: string;
  if (kind === 'job') {
    const job = await access.control.status(id);
    context = `${t(`replies:archive.view_work_${job.command}`)} · ${date(job.createdAt)}`;
  } else {
    const { run } = await access.control.manifest(id, { limit: 1 });
    if (!run.deletable) throw new ArchiveAccessError('replies:archive.manage_plan_not_deletable');
    context = `${date(run.createdAt)} · ${t('replies:archive.manage_operation_count', { count: run.operations })}`;
  }
  const token = requestArchiveDeletion(kind, id, actor);
  return {
    content: [
      context,
      t('replies:archive.manage_target_id', { id }),
      t(`replies:archive.manage_confirm_${kind}`),
      t('replies:archive.manage_confirm_expiry'),
    ].join('\n'),
    components: rows([
      manageButton('delete-confirm', token, t('replies:archive.manage_confirm_delete'), true),
      manageButton(kind, id, t('replies:archive.manage_keep')),
    ]),
  };
};
