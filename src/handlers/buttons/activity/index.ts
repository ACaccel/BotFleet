import { MessageFlags, type ButtonInteraction, type GuildMember } from 'discord.js';
import type { BaseBot } from '@bot';
import { ButtonHandler } from '@button';

import { closeActivity, refreshAnnouncement } from '../../../application/activity/activity';
import { startRollCall } from '../../../application/roll-call/roll-call';
import type { ActivityDoc } from '../../../persistence/schemas/activity.schema';
import { canManageActivity } from '../../commands/activity-shared/authority';
import { buildActivityDepsFromBot } from '../../commands/activity-shared/deps-from-bot';
import { buildRollCallDepsFromBot } from '../../commands/roll_call/deps-from-bot';
import { ROLL_CALL_MAX_TARGETS } from '../../commands/roll_call/resolve-targets';

/** Why a join did not change anything, read back from the stored state. */
const joinRefusal = (doc: ActivityDoc, userId: string): string =>
  (doc.status ?? 'open') !== 'open'
    ? 'not_open'
    : doc.participants.includes(userId)
      ? 'already_joined'
      : 'full';

/** The announcement's buttons; the activity is the message they sit on. */
export default class activity extends ButtonHandler {
  public override async execute(interaction: ButtonInteraction, bot: BaseBot): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const t = (key: string, params?: Record<string, string | number>): string =>
      bot.translator?.t(`replies:activity.${key}`, params) ?? '';
    const answer = (key: string, params?: Record<string, string | number>) =>
      interaction.editReply({ content: t(key, params) });
    const guild = interaction.guild;
    const repos = guild ? bot.getRepos(guild.id) : undefined;
    if (!guild || !repos) return void (await answer('not_found'));
    const activityId = interaction.message.id;
    const found = await repos.activity.findByActivityId(activityId);
    if (!found.ok) throw found.error;
    const doc = found.value;
    if (!doc) return void (await answer('not_found'));
    const deps = buildActivityDepsFromBot(bot);
    const userId = interaction.user.id;

    switch (interaction.customId.split('|')[1]) {
      case 'join': {
        const member = interaction.member as GuildMember | null;
        if (doc.role_id && !member?.roles.cache.has(doc.role_id)) {
          return void (await answer('role_required', { role: `<@&${doc.role_id}>` }));
        }
        const joined = await repos.activity.join(activityId, userId);
        if (!joined.ok) throw joined.error;
        if (!joined.value) return void (await answer(joinRefusal(doc, userId)));
        await refreshAnnouncement(deps, guild.id, activityId);
        return void (await answer('joined', { title: doc.title }));
      }
      case 'leave': {
        const left = await repos.activity.leave(activityId, userId);
        if (!left.ok) throw left.error;
        if (!left.value) {
          return void (await answer((doc.status ?? 'open') !== 'open' ? 'not_open' : 'not_joined'));
        }
        await refreshAnnouncement(deps, guild.id, activityId);
        return void (await answer('left', { title: doc.title }));
      }
      case 'close': {
        if (!canManageActivity(interaction, bot, doc.creator_id)) {
          return void (await answer('manage_forbidden'));
        }
        const closed = await closeActivity(deps, guild.id, activityId);
        return void (await answer(closed ? 'closed' : 'not_open'));
      }
      case 'rollcall': {
        if (!canManageActivity(interaction, bot, doc.creator_id)) {
          return void (await answer('manage_forbidden'));
        }
        const channel = interaction.channel;
        if (doc.participants.length === 0 || !channel?.isSendable()) {
          return void (await answer('no_participants'));
        }
        if (doc.participants.length > ROLL_CALL_MAX_TARGETS) {
          return void (await answer('too_many_to_call', { max: ROLL_CALL_MAX_TARGETS }));
        }
        await startRollCall(buildRollCallDepsFromBot(bot), {
          guild,
          channel,
          creatorId: userId,
          targets: doc.participants,
          persona: bot.personaName,
          activityId,
        });
        return void (await answer('roll_call_started'));
      }
      default:
        return void (await answer('not_found'));
    }
  }
}
