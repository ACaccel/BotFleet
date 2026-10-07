import { ComponentType, type StringSelectMenuInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { SSMHandler } from '../ssm-handler';
import { ArchiveAccessError, requireArchiveAccess } from '../../commands/archive/access';
import { archiveFailure, publishArchiveReply } from '../../commands/archive/replies';
import { dispatchArchiveManagement } from '../../commands/archive/manage-dispatch';
import { resolveArchiveReference } from '../../commands/archive/manage-references';

const actions = new Set([
  'jobs',
  'jobs-active',
  'plans',
  'job',
  'plan',
  'stop',
  'delete-job',
  'delete-plan',
  'delete-all-jobs',
  'delete-all-plans',
  'apply',
  'resume',
  'rollback',
  'accept',
  'inspect',
  'changes',
  'details',
]);

export default class archive_actions extends SSMHandler {
  public override async execute(
    interaction: StringSelectMenuInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferUpdate();
    try {
      const access = await requireArchiveAccess(interaction, bot);
      const value = interaction.values[0];
      const offered = interaction.message.components.some(
        (row) =>
          row.type === ComponentType.ActionRow &&
          row.components.some(
            (component) =>
              component.type === ComponentType.StringSelect &&
              component.customId === 'archive_actions' &&
              component.options.some((option) => option.value === value),
          ),
      );
      if (
        bot.client.user === null ||
        interaction.message.author.id !== bot.client.user.id ||
        interaction.customId !== 'archive_actions' ||
        interaction.values.length !== 1 ||
        !offered
      )
        throw new ArchiveAccessError('replies:archive.navigation_stale');
      const match = /^([a-z-]+)\|([A-Za-z0-9:_-]{1,160})$/.exec(value ?? '');
      if (match?.[1] === undefined || match[2] === undefined)
        throw new ArchiveAccessError('replies:archive.navigation_stale');
      const target =
        match[1] === 'ref' ? resolveArchiveReference(match[2]) : { action: match[1], id: match[2] };
      if (!actions.has(target.action))
        throw new ArchiveAccessError('replies:archive.invalid_action');
      await publishArchiveReply(
        interaction,
        await dispatchArchiveManagement(target.action, target.id, interaction, bot, access),
        bot,
        access,
      );
    } catch (error) {
      await archiveFailure(interaction, bot, error);
    }
  }
}
