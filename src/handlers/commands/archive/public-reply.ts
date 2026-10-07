import type { InteractionReplyOptions } from 'discord.js';
import type { BaseBot } from '@bot';
import { ArchiveJobNotifier } from '../../../plugins/message-backup/runtime/job-notification';
import type { ArchiveAccess } from './access';

import {
  archivePublicRecord,
  archivePublicReference,
  type ArchivePublicTarget,
} from './public-reference';
import { ensureArchiveStandaloneReference } from './standalone-public';

export { archivePublicReference, archiveConfirmationReference } from './public-reference';
const targets = new WeakMap<InteractionReplyOptions, ArchivePublicTarget>();

export const archivePublicReply = (
  payload: InteractionReplyOptions,
  target: ArchivePublicTarget,
): InteractionReplyOptions => {
  targets.set(payload, target);
  return payload;
};
export const archivePublicReplyTarget = (
  payload: InteractionReplyOptions,
): ArchivePublicTarget | undefined => targets.get(payload);

/** Only a missing Discord message can cause the notifier to replace a durable notice. */
export const ensureArchivePublicReference = async (
  bot: BaseBot,
  access: ArchiveAccess,
  target: ArchivePublicTarget,
  options: { restoreStatus?: boolean } = {},
): Promise<{ channelId: string; messageId: string } | undefined> => {
  const record = await archivePublicRecord(access, target);
  if (record === undefined)
    return 'runId' in target
      ? ensureArchiveStandaloneReference(bot, access, target.runId)
      : undefined;
  if (bot.translator === undefined) throw new Error('Archive translator unavailable');
  const notifier = new ArchiveJobNotifier({
    client: bot.client,
    registry: bot.guildRegistry,
    logger: bot.requireLogger(),
    connection: access.connection,
    guildId: access.guildId,
    translator: bot.translator,
  });
  if ('job' in record) await notifier.publish(record.job, undefined, true, options);
  else await notifier.publishScan(record.scan.runId, undefined, true, options);
  return archivePublicReference(access, target);
};
