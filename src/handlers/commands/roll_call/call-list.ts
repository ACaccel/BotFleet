import type { ChatInputCommandInteraction, Guild } from 'discord.js';
import type { BaseBot } from '@bot';

import { getOptionalString } from '../../../infra/discord/options';
import { visibleActivities } from '../activity-shared/visible';
import { createGuildMemberSource } from './member-source';
import { rollCallOutcomeReply } from './outcome-reply';
import { resolveRollCallTargets, ROLL_CALL_MAX_TARGETS } from './resolve-targets';

export type CallList =
  | { readonly status: 'ok'; readonly targets: readonly string[]; readonly activityId?: string }
  | {
      readonly status: 'refused';
      readonly key: string;
      readonly params?: Record<string, string | number>;
    };

/**
 * Who a roll call calls: an activity's participants, or the members and
 * role members named by `users` and `role`. An activity is not consumed;
 * it can be called again.
 */
export const resolveCallList = async (
  interaction: ChatInputCommandInteraction,
  bot: BaseBot,
  guild: Guild,
): Promise<CallList> => {
  const activityId = getOptionalString(interaction, 'activity');
  if (activityId !== undefined) {
    const found = bot.getRepos(guild.id)?.activity;
    const result = found ? await found.findByActivityId(activityId) : undefined;
    if (result !== undefined && !result.ok) throw result.error;
    const doc = result?.value;
    if (!doc || visibleActivities(guild, interaction.user.id, [doc]).length === 0) {
      return { status: 'refused', key: 'replies:roll_call.activity_not_found' };
    }
    if (doc.participants.length === 0) {
      return { status: 'refused', key: 'replies:roll_call.no_participants' };
    }
    if (doc.participants.length > ROLL_CALL_MAX_TARGETS) {
      return {
        status: 'refused',
        key: 'replies:roll_call.too_many_targets',
        params: { count: doc.participants.length, max: ROLL_CALL_MAX_TARGETS },
      };
    }
    return { status: 'ok', targets: doc.participants, activityId };
  }

  const roleId = getOptionalString(interaction, 'role');
  const users = getOptionalString(interaction, 'users');
  const mentions = [users?.trim(), roleId === undefined ? undefined : `<@&${roleId}>`]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' ');
  if (mentions === '') return { status: 'refused', key: 'replies:roll_call.missing_target' };
  // Role membership needs every member, not just the gateway cache.
  const source = createGuildMemberSource(guild, await guild.members.fetch());
  const outcome = resolveRollCallTargets(mentions, source, ROLL_CALL_MAX_TARGETS);
  if (outcome.status !== 'ok') return { status: 'refused', ...rollCallOutcomeReply(outcome) };
  return { status: 'ok', targets: outcome.members.map((member) => member.id) };
};
