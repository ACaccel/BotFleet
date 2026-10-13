import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';

import type { BaseBot } from '@bot';
import { bindTranslator } from '../../../core/i18n';
import {
  createTempRole,
  DEFAULT_TEMP_ROLE_DAYS,
  MAX_GUILD_ROLES,
  MAX_TEMP_ROLE_DAYS,
} from '../../../application/temp-role/temp-role';
import { buildTempRoleDepsFromBot } from './deps-from-bot';
import { parseTempRoleConfig } from './config';
import { getOptionalNumber, getRequiredString } from '../../../infra/discord/options';

/**
 * `/role temp create` — create a permission-less, mentionable role that anyone
 * can self-claim via a toggle button, auto-deleted after a chosen number
 * of days (capped at {@link MAX_TEMP_ROLE_DAYS}).
 *
 * Open to every member by design: the created role grants no
 * permissions, so the only blast radius is the guild role count, which
 * the {@link MAX_GUILD_ROLES} guard protects.
 *
 * Validation failures are answered here; unexpected failures (a Discord
 * API error, a re-thrown `DatabaseError` from the rollback path) are
 * left to propagate to the command handler's `replyForError` boundary so
 * the user sees a trace-id-stamped message.
 */
export const handleTempRoleCreate = async (
  interaction: ChatInputCommandInteraction,
  bot: BaseBot,
): Promise<void> => {
  // Acknowledge ephemerally so validation errors stay private; on
  // success the ephemeral reply is deleted, leaving the public claim
  // message as the only intended output.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const t = bindTranslator(bot.translator);
  const deps = buildTempRoleDepsFromBot(bot);

  const name = getRequiredString(interaction, 'name');
  const daysRaw = getOptionalNumber(interaction, 'days');

  if (!name || name.trim().length === 0) {
    await interaction.editReply({ content: t('replies:temp_role.missing_name') });
    return;
  }

  // Discord enforces min:1 / max:30 on the option, but validate again so
  // a non-conforming payload still gets our localised error.
  const days = daysRaw ?? DEFAULT_TEMP_ROLE_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > MAX_TEMP_ROLE_DAYS) {
    await interaction.editReply({
      content: t('replies:temp_role.invalid_duration', { max: MAX_TEMP_ROLE_DAYS }),
    });
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: t('errors:command.guild_not_found') });
    return;
  }

  const channel = interaction.channel;
  if (!channel?.isSendable()) {
    await interaction.editReply({ content: t('errors:command.channel_not_found') });
    return;
  }

  const outcome = await createTempRole(deps, {
    guild,
    channel,
    creatorId: interaction.user.id,
    roleName: name.trim(),
    days,
    maxActivePerMember: parseTempRoleConfig(bot.config).maxActivePerMember,
  });

  switch (outcome.status) {
    case 'role_limit':
      await interaction.editReply({
        content: t('replies:temp_role.at_role_limit', { max: MAX_GUILD_ROLES }),
      });
      return;
    case 'no_db':
      await interaction.editReply({ content: t('errors:db.not_found') });
      return;
    case 'announce_failed':
      await interaction.editReply({ content: t('replies:temp_role.announce_failed') });
      return;
    case 'too_many':
      await interaction.editReply({
        content: t('replies:temp_role.too_many', { max: outcome.max }),
      });
      return;
    case 'name_taken':
      await interaction.editReply({ content: t('replies:temp_role.name_taken') });
      return;
    case 'created':
      // The public claim message is the only intended output.
      await interaction.deleteReply();
      return;
    default: {
      // Compile-time exhaustiveness guard: a new CreateTempRoleOutcome
      // variant must be handled above.
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
};
