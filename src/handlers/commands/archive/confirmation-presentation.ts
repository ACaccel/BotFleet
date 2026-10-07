import { ButtonBuilder, ButtonStyle, type InteractionReplyOptions } from 'discord.js';
import type { BaseBot } from '@bot';
import { bindTranslator, type BoundTranslate } from '../../../core/i18n';
import {
  archiveViewId,
  browseViews,
  button,
  date,
  present,
  rows,
  type Confirmation,
} from './presentation-common';
import { manageBack, manageButton } from './manage-common';
import { summaryLines } from './plan-summary';
import { archiveGuildLabel } from './source-presentation';
import { rollbackSummaryLines } from './rollback-presentation';

const actionLabel = (t: BoundTranslate, action: Confirmation['action']): string =>
  t(`replies:archive.confirm_action_${action}`);

export const archivePlanActions = (
  run: Confirmation['run'],
  t: BoundTranslate,
  currentAction?: Confirmation['action'],
  includeBack = true,
): ButtonBuilder[] => [
  ...(currentAction !== 'rollback' && run.actions.includes('rollback')
    ? [manageButton('rollback', run.runId, actionLabel(t, 'rollback'), true)]
    : []),
  ...(run.deletable
    ? [manageButton('delete-plan', run.runId, t('replies:archive.manage_delete_plan'), true)]
    : []),
  ...(includeBack ? [manageBack('plans', t)] : []),
];

/** Render the exact run and aggregate returned with the durable approval token. */
export const archiveConfirmationReply = (
  confirmation: Confirmation,
  bot: BaseBot,
  actor?: { userId: string; channelId: string; messageId?: string },
  extraButtons: readonly ButtonBuilder[] = [],
): InteractionReplyOptions => {
  const t = bindTranslator(bot.translator);
  const action = confirmation.action;
  const guildLabel = archiveGuildLabel(
    bot.client?.guilds?.cache.get(confirmation.run.guildId),
    confirmation.run.guildId,
    40,
  );
  const lines =
    action === 'rollback'
      ? rollbackSummaryLines(confirmation, t, guildLabel)
      : summaryLines(confirmation.run, confirmation.summary, t, guildLabel);
  lines.push(
    t(
      `replies:archive.${action === 'apply' ? 'plan_next_apply' : action === 'accept' ? 'plan_next_accept' : action === 'resume' ? 'plan_next_resume' : 'confirm_rollback_effect'}`,
    ),
  );
  lines.push(t('replies:archive.confirm_bound', { expires: date(confirmation.expiresAt, 'R') }));
  if (actor !== undefined)
    lines.push(t('commands:archive_ui.confirm_actor', { actor: `<@${actor.userId}>` }));
  const confirm = new ButtonBuilder()
    .setCustomId(`archive_confirm|${confirmation.token}`)
    .setLabel(actionLabel(t, action))
    .setStyle(action === 'rollback' ? ButtonStyle.Danger : ButtonStyle.Primary);
  const views =
    actor === undefined
      ? [
          button(
            archiveViewId(confirmation.run.runId, 'changes'),
            t('replies:archive.view_changes'),
          ),
        ].filter(present)
      : browseViews(
          confirmation.run.runId,
          { ...actor, guildId: confirmation.run.guildId },
          t,
          'summary',
        ).flatMap((row) => row.components);
  const actions = archivePlanActions(confirmation.run, t, action, false);
  const controls = [confirm, ...views, ...extraButtons, ...actions].slice(0, 5);
  if (controls.length < 5) controls.push(manageBack('plans', t));
  return {
    content: lines.join('\n'),
    components: rows(controls),
  };
};
