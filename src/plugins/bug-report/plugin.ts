/**
 * BugReportPlugin — relays `/bug_report` conversations and checks the hub.
 *
 * Admin messages in a ticket's hub forum post are forwarded to the
 * reporter by DM, and the reporter's DMs back to the post. On ready, the
 * hub forum and the bot's permissions there are verified; a failure
 * disables the plugin so startup readiness reports it. A bot without a
 * `bug_report` block registers the plugin as a no-op.
 */
import { TOKENS } from '../../bot/tokens';
import type { Plugin, PluginEventContext, PluginRuntimeContext } from '../../core/plugin';
import { readBugReportConfig } from '../../application/bug-report/config';
import { relayAdminMessage, relayReporterDm } from '../../application/bug-report/relay';
import {
  hubTicketStore,
  verifyHub,
  type BugReportDeps,
} from '../../application/bug-report/tickets';

const PLUGIN_ID = 'bug-report';
const PLUGIN_VERSION = '1.0.0';

interface BugReportPluginOptions {
  /** The bot's raw `bug_report` config block. */
  readonly config: unknown;
  readonly isAdmin: (userId: string) => boolean;
  /** How hub posts name this bot; read lazily, after the persona is resolved. */
  readonly label: () => string;
}

export const createBugReportPlugin = (options: BugReportPluginOptions): Plugin => {
  const config = readBugReportConfig({ bug_report: options.config });

  const depsFrom = (ctx: PluginRuntimeContext | PluginEventContext): BugReportDeps | undefined => {
    if (config === undefined) return undefined;
    const client = ctx.resolve(TOKENS.DiscordClient);
    return {
      client,
      tickets: hubTicketStore(ctx.resolve(TOKENS.ConnectionManager), config.hub.guildId),
      botId: client.user?.id ?? '',
      botLabel: options.label(),
      config,
      translator: ctx.translator,
      logger: ctx.logger,
      isAdmin: options.isAdmin,
    };
  };

  return {
    id: PLUGIN_ID,
    version: PLUGIN_VERSION,
    async onReady(ctx): Promise<void> {
      const deps = depsFrom(ctx);
      if (deps !== undefined) await verifyHub(deps);
    },
    events: {
      messageCreate: async (ctx, message): Promise<void> => {
        const deps = depsFrom(ctx);
        if (deps === undefined || message.author.bot) return;
        if (message.guildId === null) await relayReporterDm(deps, message);
        else if (message.guildId === config?.hub.guildId) await relayAdminMessage(deps, message);
      },
    },
  };
};
