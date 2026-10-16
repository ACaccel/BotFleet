import { MessageFlags, type ModalSubmitInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { ModalHandler } from '@modal';

import { createActivity } from '../../../application/activity/activity';
import { logError } from '../../../core/logger';
import { buildActivityDepsFromBot } from '../../commands/activity-shared/deps-from-bot';
import {
  parseCapacity,
  parseDeadline,
  parseStartTime,
} from '../../commands/activity-shared/parse-input';

/** `/activity create` form submit: validate, then post in the invoking channel. */
export default class activity_create_modal extends ModalHandler {
  public override async execute(interaction: ModalSubmitInteraction, bot: BaseBot): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const t = (key: string, params?: Record<string, string | number>): string =>
      bot.translator?.t(`replies:activity.${key}`, params) ?? '';
    const field = (id: string): string => interaction.fields.getTextInputValue(id).trim();
    try {
      const guild = interaction.guild;
      const channel = interaction.channel;
      if (!guild || !channel?.isSendable()) {
        await interaction.editReply({
          content: bot.translator?.t('errors:command.channel_not_found') ?? '',
        });
        return;
      }
      const now = Date.now();
      const title = field('title');
      const deadline = parseDeadline(field('deadline'), now);
      const startRaw = field('start');
      const start = startRaw === '' ? undefined : parseStartTime(startRaw, now, bot.timeZone);
      const capacity = parseCapacity(field('capacity'));
      const problem =
        title === ''
          ? 'missing_title'
          : deadline === null
            ? 'invalid_deadline'
            : start === null
              ? 'invalid_start'
              : capacity === null
                ? 'invalid_capacity'
                : undefined;
      if (problem !== undefined || deadline === null || start === null || capacity === null) {
        await interaction.editReply({ content: t(problem ?? 'invalid_deadline') });
        return;
      }

      const roleId = interaction.customId.split('|')[1];
      const outcome = await createActivity(buildActivityDepsFromBot(bot), guild, channel, {
        title,
        description: field('description'),
        creator_id: interaction.user.id,
        expired_at: deadline,
        ...(roleId ? { role_id: roleId } : {}),
        ...(capacity !== undefined ? { capacity } : {}),
        ...(start !== undefined ? { starts_at: start } : {}),
      });
      await interaction.editReply({
        content:
          outcome.status === 'created'
            ? t('created')
            : outcome.status === 'no_db'
              ? (bot.translator?.t('errors:db.not_found') ?? '')
              : t('announce_failed'),
      });
    } catch (error) {
      logError(bot.logger, interaction.guildId, error);
      await interaction.editReply({ content: t('create_failed') });
    }
  }
}
