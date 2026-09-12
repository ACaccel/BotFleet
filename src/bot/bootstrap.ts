/**
 * Shared entry-point body for the five personality composition roots.
 *
 * Every `src/bot/<name>/index.ts` performs the same four steps in the
 * same order — load the personality's `.env`, validate it into a typed
 * {@link Env}, construct the Discord client with that personality's
 * gateway intents, then start the bot under the {@link runOrExit}
 * failure policy. Only the intent list and the constructor call differ,
 * so those are the parameters and everything else lives here; a startup
 * concern added here reaches all five personalities at once.
 */
import { Client, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';

import { loadEnv, type Env } from '../core/config';

import { runOrExit, type StartablePersonality } from './run-or-exit';

/**
 * Intents for a personality that observes the whole guild: message
 * edits and deletes, member and role changes, invites,
 * scheduled events, automod. What the guild-events / activity /
 * message-backup feature set needs to see.
 */
export const GUILD_OBSERVER_INTENTS: readonly GatewayIntentBits[] = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildEmojisAndStickers,
  GatewayIntentBits.GuildIntegrations,
  GatewayIntentBits.GuildWebhooks,
  GatewayIntentBits.GuildInvites,
  GatewayIntentBits.GuildPresences,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.GuildMessageTyping,
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.DirectMessageReactions,
  GatewayIntentBits.DirectMessageTyping,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildScheduledEvents,
  GatewayIntentBits.AutoModerationConfiguration,
  GatewayIntentBits.AutoModerationExecution,
];

/**
 * Intents for a personality that only reads and answers messages. The
 * minimum for slash commands, message content, and reactions — a bot
 * that mirrors nothing has no reason to receive the rest.
 */
export const MESSAGE_BOT_INTENTS: readonly GatewayIntentBits[] = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.MessageContent,
];

interface BootstrapOptions {
  /**
   * Personality directory name under `src/bot/`. Selects the `.env` file
   * loaded before validation.
   */
  readonly name: string;
  readonly intents: readonly GatewayIntentBits[];
  /** Env requirements this personality cannot start without. */
  readonly env?: {
    /** Require a usable `MONGO_URI`. Defaults to true. */
    readonly requireDb?: boolean;
    /** Require a `PORT`; set by personalities that bind an HTTP server. */
    readonly requirePort?: boolean;
  };
  /** Construct the personality from its validated env and client. */
  readonly build: (client: Client, env: Env) => StartablePersonality;
}

/**
 * Boot one personality. Returns once startup has been handed to
 * {@link runOrExit}, which owns the failure path (log, best-effort
 * teardown, exit 1) so a rejected login can never leave a zombie
 * process behind.
 */
export const bootstrapPersonality = (options: BootstrapOptions): void => {
  dotenv.config({ path: `./src/bot/${options.name}/.env` });
  const env = loadEnv({
    requireDb: options.env?.requireDb ?? true,
    requirePort: options.env?.requirePort ?? false,
  });
  const client = new Client({ intents: [...options.intents] });
  // `runOrExit` is written to always resolve, so the `catch` is the last
  // hole in the entry-point failure path rather than a routine branch:
  // it covers a throw on the failure path itself (a logger that is bound
  // but broken). stderr is the only sink guaranteed to work there.
  void runOrExit(options.build(client, env)).catch((err: unknown) => {
    process.stderr.write(`bot startup failed and the failure path threw: ${String(err)}\n`);
    process.exit(1);
  });
};
