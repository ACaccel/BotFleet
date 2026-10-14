/**
 * Earthquake broadcast logic.
 *
 * Two fan-outs share the guild's `earthquake` channel:
 *   - the early-warning alert goes to guilds that also configure an
 *     `earthquake` role, which it pings;
 *   - the CWA report goes to every guild with the channel and pings
 *     nobody — it arrives minutes later, as information.
 * Per-guild failures are isolated and logged with the guild id.
 */
import type { Channel, Client } from 'discord.js';

import type { GuildRegistry } from '../../../bot/guild-registry';
import type { Translator } from '../../../core/i18n';
import { logError, type Logger } from '../../../core/logger';
import type { CwaReport } from './cwa-report';
import { buildReportEmbed } from './report-embed';

/** Symbolic channel / role name looked up via the guild registry. */
const EARTHQUAKE = 'earthquake';

/**
 * Send the earthquake alert to a single guild's configured channel.
 * No-op when the channel is not sendable. Extracted as a named helper
 * so it is independently unit-testable.
 */
export const sendEarthquakeAlert = async (
  channel: Channel,
  earthquakeRoleId: string,
  translator: Translator | undefined,
): Promise<void> => {
  if (!channel.isSendable()) return;
  const message = translator?.t('replies:earthquake.alert', { role: earthquakeRoleId }) ?? '';
  if (message.length === 0) return;
  await channel.send(message);
};

/**
 * Broadcast the earthquake alert to every guild that has an
 * `earthquake` channel and role configured. Per-guild errors are
 * caught and funnelled into the structured logger so one guild's
 * failure never aborts the rest of the fan-out.
 */
export const broadcastEarthquakeAlert = async (
  client: Client,
  registry: GuildRegistry,
  translator: Translator | undefined,
  logger: Logger | undefined,
): Promise<void> => {
  const guildIds = [...client.guilds.cache.keys()];
  await Promise.all(
    guildIds.map(async (guildId) => {
      try {
        const channel = registry.getChannel(guildId, EARTHQUAKE);
        const role = registry.getRole(guildId, EARTHQUAKE);
        if (channel === undefined || role === undefined) return;
        await sendEarthquakeAlert(channel, role.id, translator);
      } catch (err: unknown) {
        logError(logger, guildId, err);
      }
    }),
  );
};

/**
 * Post a CWA earthquake report to every guild with an `earthquake`
 * channel. The embed is built once (the language is per bot, not per
 * guild) and mentions are disabled outright, so a report can never ping
 * even if upstream text happened to contain mention syntax.
 */
export const broadcastEarthquakeReport = async (
  client: Client,
  registry: GuildRegistry,
  report: CwaReport,
  translator: Translator,
  logger: Logger | undefined,
): Promise<void> => {
  const embed = buildReportEmbed(report, translator);
  const guildIds = [...client.guilds.cache.keys()];
  await Promise.all(
    guildIds.map(async (guildId) => {
      try {
        const channel = registry.getChannel(guildId, EARTHQUAKE);
        if (channel === undefined || !channel.isSendable()) return;
        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
      } catch (err: unknown) {
        logError(logger, guildId, err);
      }
    }),
  );
};
