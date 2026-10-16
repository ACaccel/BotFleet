/**
 * CWA report fan-out. A report goes to every guild with an `earthquake`
 * channel and pings nobody: it arrives minutes after the quake, as
 * information. Early-warning alerts are delivered by `alert-dispatcher.ts`.
 * Per-guild failures are isolated and logged with the guild id.
 */
import type { Client } from 'discord.js';

import type { GuildRegistry } from '../../../bot/guild-registry';
import type { Translator } from '../../../core/i18n';
import { logError, type Logger } from '../../../core/logger';
import type { GuildSettingsRuntime } from '../../../core/guild-settings';
import { resolveEarthquakeDestination } from './destination';
import type { CwaReport } from './cwa-report';
import { buildReportEmbed } from './report-embed';

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
  settings?: GuildSettingsRuntime,
): Promise<void> => {
  const embed = buildReportEmbed(report, translator);
  const guildIds = [...client.guilds.cache.keys()];
  await Promise.all(
    guildIds.map(async (guildId) => {
      try {
        const destination = await resolveEarthquakeDestination(
          client,
          registry,
          guildId,
          'reports',
          settings,
        );
        if (!destination) return;
        const { channel } = destination;
        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
      } catch (err: unknown) {
        logError(logger, guildId, err);
      }
    }),
  );
};
