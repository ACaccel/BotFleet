import type { MessageReaction, User } from 'discord.js';
import { ReactionHandler } from '..';
import type { BaseBot } from '@bot';

/**
 * Keeps the `/roll_call` tally in sync with the ✅ reactions on the
 * announcement message.
 *
 * The announcement is produced from `replies:roll_call.announcement_header`,
 * so the prefix this matches on must come from the same catalog
 * (`replies:roll_call.trigger_prefix`). A hard-coded zh-TW literal never
 * matched an English-locale announcement, and the tally silently did
 * nothing for those bots.
 */
export default class roll_call extends ReactionHandler {
  public override async executeAdded(
    reaction: MessageReaction,
    user: User,
    bot: BaseBot,
  ): Promise<void> {
    await rollCallReact(reaction, user, bot);
  }

  public override async executeRemoved(
    reaction: MessageReaction,
    user: User,
    bot: BaseBot,
  ): Promise<void> {
    await rollCallReact(reaction, user, bot);
  }
}

const rollCallReact = async (
  reaction: MessageReaction,
  _user: User,
  bot: BaseBot,
): Promise<void> => {
  const triggerPrefix =
    bot.translator?.t('replies:roll_call.trigger_prefix', { persona: bot.personaName }) ?? '';
  if (triggerPrefix.length === 0) return;
  if (!reaction.message.content?.startsWith(triggerPrefix)) return;

  // parse all users
  const userIds = reaction.message.content.match(/<@!?(\d+)>/g);
  let parsedUserIds = userIds ? userIds.map((id) => id.replace(/[<@!>]/g, '')) : [];
  parsedUserIds = parsedUserIds.slice(1);

  let msg = `${reaction.message.content.split('\n')[0]}\n`;
  let count = 1;
  parsedUserIds.forEach((id) => {
    if (reaction.users.cache.has(id)) {
      msg += `${count}. ✅ <@${id}> \n`;
    } else {
      msg += `${count}. <@${id}> \n`;
    }
    count += 1;
  });

  await reaction.message.edit(msg);
};
