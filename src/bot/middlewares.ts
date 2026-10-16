/**
 * Default interaction middlewares for {@link InteractionRouter}.
 *
 *   - {@link createDispatchMiddleware} — terminal stage. Routes the
 *     interaction to the right `execute*` dispatcher based on its
 *     discriminant, including the autocomplete branch, which is
 *     answered with suggestions rather than a reply. Calls `next()`
 *     after dispatch so logging middleware runs.
 *   - {@link createChannelLoggingMiddleware} — slash-command logging
 *     sink. Consults the {@link PermissionRankPolicy} so commands run in
 *     channels above the `channel_logging` rank ceiling stay out of the
 *     debug feed (the durable guild audit log is never suppressed).
 *     A middleware so a bot that wants a different logging policy
 *     declares one instead of overriding the command dispatcher.
 */
import { EMBED_COLORS } from '../infra/discord/presentation-colors';
import { featureForInteraction } from '../application/guild-settings/feature-gate';
import {
  EntertainmentGate,
  entertainmentCommandFor,
} from '../application/guild-settings/entertainment';
import { EmbedBuilder, MessageFlags, channelMention, userMention } from 'discord.js';
import type { BaseBot } from './index';
import { executeAutocomplete, executeCommand } from '@cmd';
import { executeButton } from '@button';
import { executeModal } from '@modal';
import { executeSSM } from '@select-menu';
import { logGuildEvent } from '@core/logger';
import { bindTranslator, withGuildContext } from '@core/i18n';
import { ancestorChannelIdsOf, sendChannelLog } from '../infra/discord';
import { guildIdForInteraction } from '../core/plugin/event-guild';
import type {
  InteractionContext,
  InteractionMiddleware,
  PermissionRankPolicy,
} from '../core/plugin';

/** Keep shared translator/time-zone readers scoped across the entire dispatch chain. */
export const createGuildLocaleMiddleware = (bot: BaseBot): InteractionMiddleware => ({
  name: 'guild-locale',
  run: (ctx, next) =>
    withGuildContext(bot.translator, guildIdForInteraction(ctx.interaction), next),
});

/**
 * Routes the inbound interaction to the matching dispatcher. Calls
 * `next()` after dispatch so observability middleware (channel logger,
 * future tracing hooks) still runs even when the dispatcher returned a
 * user-facing reply.
 */
export const createDispatchMiddleware = (bot: BaseBot): InteractionMiddleware => {
  // One gate per middleware keeps cooldowns isolated per application.
  const entertainment = new EntertainmentGate();
  return {
    name: 'dispatch',
    async run(ctx: InteractionContext, next): Promise<void> {
      const interaction = ctx.interaction;
      const settings = bot.guildSettings;
      if (settings && interaction.guildId) {
        const commandId =
          interaction.isChatInputCommand() ||
          interaction.isContextMenuCommand() ||
          interaction.isAutocomplete()
            ? bot.commandHandlers.get(interaction.commandName)?.config.name
            : undefined;
        const feature = featureForInteraction(interaction, commandId);
        if (
          feature &&
          !settings.isEnabled(
            interaction.guildId,
            feature,
            interaction.channelId ?? undefined,
            ancestorChannelIdsOf(interaction.channel, interaction.guild?.channels.cache),
          )
        ) {
          if (interaction.isAutocomplete()) await interaction.respond([]);
          else if (interaction.isRepliable()) {
            await interaction.reply({
              content:
                bot.translator?.t(
                  settings.get(interaction.guildId)
                    ? 'replies:settings.feature_disabled'
                    : 'replies:settings.unavailable',
                  { feature: bot.translator?.t(`replies:settings.feature.${feature}`) ?? feature },
                ) ?? '',
              flags: MessageFlags.Ephemeral,
            });
          }
          await next();
          return;
        }
        const command = entertainmentCommandFor(interaction, commandId);
        if (command) {
          const access = entertainment.check(
            settings,
            interaction.guildId,
            interaction.user.id,
            command,
          );
          if (!access.allowed) {
            if (interaction.isRepliable())
              await interaction.reply({
                content:
                  bot.translator?.t(
                    access.reason === 'cooldown'
                      ? 'replies:settings.entertainment_cooldown'
                      : 'replies:settings.entertainment_disabled',
                    access.reason === 'cooldown' ? { seconds: access.seconds } : undefined,
                  ) ?? '',
                flags: MessageFlags.Ephemeral,
              });
            await next();
            return;
          }
        }
      }
      // Autocomplete first: it is the one branch that must never reply,
      // and answering it is a different verb (`respond`) with a
      // three-second budget. `executeAutocomplete` swallows its own
      // failures, so the chain below still runs either way.
      if (interaction.isAutocomplete()) {
        await executeAutocomplete(interaction, bot);
      } else if (interaction.isChatInputCommand() || interaction.isContextMenuCommand()) {
        await executeCommand(interaction, bot);
      } else if (interaction.isModalSubmit()) {
        await executeModal(interaction, bot);
      } else if (interaction.isButton()) {
        await executeButton(interaction, bot);
      } else if (
        interaction.isStringSelectMenu() ||
        interaction.isChannelSelectMenu() ||
        interaction.isRoleSelectMenu()
      ) {
        await executeSSM(interaction, bot);
      } else if (interaction.isRepliable()) {
        await interaction.reply({
          content: bot.translator?.t('errors:command.unsupported_interaction_type') ?? '',
          flags: MessageFlags.Ephemeral,
        });
      }
      await next();
    },
  };
};

interface ChannelLoggingMiddlewareConfig {
  /**
   * Privacy / clearance ranking. A command whose channel (or its parent
   * thread) is suppressed for the `channel_logging` feature stays out of
   * the debug feed.
   */
  readonly policy: PermissionRankPolicy;
}

/**
 * Emits the per-command channel embed + guild log line. Only fires
 * for slash-command / context-menu interactions — other interaction
 * types are not logged. The {@link PermissionRankPolicy} (matching the
 * channel or its parent thread against the `channel_logging` ceiling)
 * suppresses the debug-channel embed but never the guild log — the latter
 * is a permanent audit trail.
 */
export const createChannelLoggingMiddleware = (
  bot: BaseBot,
  config: ChannelLoggingMiddlewareConfig,
): InteractionMiddleware => ({
  name: 'channel-logging',
  async run(ctx: InteractionContext, next): Promise<void> {
    // try/finally so the durable guild audit-trail entry STILL
    // lands even if dispatch threw. Re-throw any caught error so
    // the outer handler still surfaces it to the user.
    try {
      await next();
    } finally {
      const interaction = ctx.interaction;
      if (interaction.isChatInputCommand() || interaction.isContextMenuCommand()) {
        if (interaction.guildId !== null) {
          const suppressed =
            (bot.guildSettings !== undefined &&
              !bot.guildSettings.isEnabled(
                interaction.guildId,
                'channel_logging',
                interaction.channelId,
                ancestorChannelIdsOf(interaction.channel, interaction.guild?.channels.cache),
              )) ||
            config.policy.isSuppressed(
              interaction.guildId,
              'channel_logging',
              interaction.channelId,
              ancestorChannelIdsOf(interaction.channel, interaction.guild?.channels.cache),
            );
          if (!suppressed) {
            const t = bindTranslator(bot.translator);
            const commandName = interaction.isChatInputCommand()
              ? [
                  `/${interaction.commandName}`,
                  interaction.options.getSubcommandGroup(false),
                  interaction.options.getSubcommand(false),
                ]
                  .filter(Boolean)
                  .join(' ')
              : interaction.commandName;
            const embed = new EmbedBuilder()
              .setColor(EMBED_COLORS.info)
              .setTitle(commandName)
              .addFields(
                {
                  name: t('replies:base_bot.command_log.user'),
                  value: userMention(interaction.user.id),
                  inline: true,
                },
                {
                  name: t('replies:base_bot.command_log.channel'),
                  value: channelMention(interaction.channelId),
                  inline: true,
                },
              )
              .setFooter({ text: t('replies:base_bot.command_log.executed_at') })
              .setTimestamp(interaction.createdTimestamp);
            void sendChannelLog(
              bot.logger,
              bot.getGuildInfo(interaction.guildId)?.channels?.debug,
              embed,
            );
          }
        }
        if (interaction.guild) {
          const channelName =
            interaction.guild.channels.cache.get(interaction.channelId)?.name ?? '<unknown>';
          logGuildEvent(
            bot.logger,
            interaction.guild.id,
            'interaction_create',
            {
              command: `/${interaction.commandName}`,
              user: interaction.user.displayName,
              channel: channelName,
            },
            interaction.guild.name,
          );
        }
      }
    }
  },
});
