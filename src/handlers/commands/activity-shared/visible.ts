import { PermissionFlagsBits, type Guild } from 'discord.js';

import type { ActivityDoc } from '../../../persistence/schemas/activity.schema';

/**
 * Activities whose channel `userId` can see. An activity in a restricted
 * channel is private to that channel's audience, so lists and
 * suggestions must not reveal it to anyone else.
 */
export const visibleActivities = (
  guild: Guild,
  userId: string,
  activities: readonly ActivityDoc[],
): ActivityDoc[] =>
  activities.filter((doc) =>
    guild.channels.cache
      .get(doc.channel_id)
      ?.permissionsFor(userId)
      ?.has(PermissionFlagsBits.ViewChannel),
  );
