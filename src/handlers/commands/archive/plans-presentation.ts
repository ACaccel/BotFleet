import type { InteractionReplyOptions } from 'discord.js';
import type { BaseBot } from '@bot';
import type { ArchiveControlService } from '../../../infra/archive/control';
import { bindTranslator } from '../../../core/i18n';
import { date, rows, runStates } from './presentation-common';
import { manageButton } from './manage-common';
import { ARCHIVE_LIST_PAGE_SIZE } from './jobs-presentation';

export const archivePlansReply = (
  result: Awaited<ReturnType<ArchiveControlService['plans']>>,
  bot: BaseBot,
): InteractionReplyOptions => {
  const t = bindTranslator(bot.translator);
  const plans = result.plans.slice(0, ARCHIVE_LIST_PAGE_SIZE);
  const labels = plans.map(
    (plan, index) =>
      `${index + 1}. ${t(`replies:archive.run_state_${runStates.has(plan.status) ? plan.status : 'unknown'}`)}`,
  );
  const buttons = plans.map((plan, index) =>
    manageButton('plan', plan.runId, labels[index]!.slice(0, 80)),
  );
  buttons.push(manageButton('plans', 'first', t('replies:archive.manage_refresh')));
  if (plans.length > 0)
    buttons.push(
      manageButton('delete-all-plans', 'guild', t('replies:archive.bulk_delete_plans'), true),
    );
  const nextCursor = result.plans.length > plans.length ? plans.at(-1)?.runId : result.nextCursor;
  if (nextCursor !== undefined)
    buttons.push(manageButton('plans', nextCursor, t('replies:archive.page_next')));
  return {
    content: [
      t('replies:archive.manage_plans_title'),
      ...plans.map(
        (plan, index) =>
          `${labels[index]} — ${date(plan.createdAt)} · ${t('replies:archive.manage_operation_count', { count: plan.operations })}`,
      ),
      ...(plans.length === 0 ? [t('replies:archive.manage_no_plans')] : []),
    ].join('\n'),
    components: rows(buttons),
  };
};
