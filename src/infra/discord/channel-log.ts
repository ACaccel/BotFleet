/** Discord-channel audit log helper. */
import type { Channel, EmbedBuilder } from 'discord.js';

import type { Logger } from '../../core/logger';

/**
 * Send a log line / embed to a guild channel. The structured `logger`
 * receives any send failure so the caller does not have to wrap a
 * try/catch around every audit-channel mirror.
 */
export const sendChannelLog = async (
  logger: Logger | undefined,
  channel: Channel | undefined,
  embed?: EmbedBuilder,
  log?: string,
): Promise<void> => {
  try {
    if (!channel?.isSendable()) return;
    if (log !== undefined) await channel.send(log);
    if (embed !== undefined) await channel.send({ embeds: [embed] });
  } catch (e) {
    logger?.error(
      { err: e instanceof Error ? e : new Error(String(e)) },
      'sendChannelLog: send failed',
    );
  }
};
