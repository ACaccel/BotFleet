/**
 * Slash-command registration CLI.
 *
 * The default registration scope is **global**: a single
 * `rest.put(Routes.applicationCommands)` call publishes the bot's
 * command set to every guild it is in (and every guild it joins
 * later). The guild-side path is an opt-in dev path via
 * `--dev-guild <id>` so iteration on a single test guild stays
 * instant (Discord propagation for global commands can take up to an
 * hour).
 *
 * The `--cleanup-guild-commands` flag wipes guild-scoped
 * registrations: it iterates `userGuilds()` and PUTs an empty array
 * to each guild's command bucket. Run it once to clear any
 * guild-scoped entries so users do not see duplicates alongside the
 * global commands.
 *
 * Usage:
 *   yarn register -t nijika                 # global (default; also prunes guild-scoped commands)
 *   yarn register -t nijika --dev-guild ID  # guild-side fast iteration
 *   yarn register -t nijika --dry-run       # print resolved command text, register nothing
 *   yarn register -t nijika --keep-guild-commands     # global registration without pruning guild commands
 *   yarn register -t nijika --cleanup-guild-commands  # only clear guild-scoped commands
 *
 * The default global registration registers the global command set AND clears
 * guild-scoped registrations from every guild, so a stale guild-scoped
 * command (e.g. from a prior `--dev-guild` run) cannot keep overriding
 * the global one. Pass `--keep-guild-commands` to skip that step on
 * large bots or when guild-scoped commands are intentional.
 *
 * Command text is localised to the bot's `config.language` (see
 * `buildRegisterTranslator`). Global registrations can take up to an hour
 * to propagate; use `--dev-guild` for instant iteration.
 */
import type { ApplicationCommandDataResolvable } from 'discord.js';
import { REST, Routes } from 'discord.js';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

import { buildCommandJsonBody, createCommand, localizeCommandConfig } from '@cmd';
import { createBootstrapLogger, loadEnv } from '@core/config';
import { createDefaultTranslator, isLocale, type Locale, type Translator } from '@core/i18n';

import { resolveLocalesDir } from './bot/locales-dir';
import { fetchAllUserGuilds } from './register-guilds';

// Register runs before the IoC container is built, so the typed `Logger`
// bound to `TOKENS.Logger` is not available. Use the bootstrap logger
// (the same construct `BaseBot.run()` falls back to during phase 1)
// so the register CLI still emits structured pino lines instead of raw
// `console.*` writes. `fileRouter: false` keeps it console-only: register
// is a one-shot CLI with no `bot` binding (which the file router
// requires) and must not create a `logs/<botId>/` tree.
const logger = createBootstrapLogger({ component: 'register' }, { fileRouter: false });

type RegisterArgs = {
  bot?: string;
  devGuild?: string;
  cleanupGuildCommands?: boolean;
  dryRun?: boolean;
  keepGuildCommands?: boolean;
};

type BotConfig = {
  commands?: string[];
  language?: string;
};

function parseArgs(argv: string[]): RegisterArgs {
  const out: RegisterArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '-b' || a === '--bot' || a === '-t' || a === '--target') && argv[i + 1]) {
      out.bot = argv[++i];
    } else if (a === '--dev-guild' && argv[i + 1]) {
      out.devGuild = argv[++i];
    } else if (a === '--cleanup-guild-commands') {
      out.cleanupGuildCommands = true;
    } else if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '--keep-guild-commands') {
      out.keepGuildCommands = true;
    }
  }

  return out;
}

function resolveBotPaths(botName: string) {
  const baseDir = path.resolve(__dirname, 'bot', botName);
  const configPath = path.join(baseDir, 'config.json');
  const envPath = path.join(baseDir, '.env');

  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  if (!fs.existsSync(envPath)) {
    throw new Error(`Env file not found: ${envPath}`);
  }

  return { baseDir, configPath, envPath };
}

function loadBotConfig(botName: string): {
  token: string;
  clientId: string;
  commands: string[];
  language?: string;
} {
  const { configPath, envPath } = resolveBotPaths(botName);

  dotenv.config({ path: envPath });
  const env = loadEnv({ exitOnFailure: false, requireDb: false });
  const token = env.TOKEN;
  const clientId = env.CLIENT_ID;

  const raw = fs.readFileSync(configPath, 'utf8');
  const cfg = JSON.parse(raw) as BotConfig;

  if (!cfg.commands || !Array.isArray(cfg.commands) || cfg.commands.length === 0) {
    throw new Error(`No commands defined in ${configPath}`);
  }

  return { token, clientId, commands: cfg.commands, language: cfg.language };
}

/**
 * Build the translator the registered command JSON is localised against,
 * honouring the bot's `config.language` (mirrors `BaseBot.buildHost`).
 * An unsupported value warns and falls back to the framework default so
 * command descriptions register in the locale the running bot will use.
 */
async function buildRegisterTranslator(language: string | undefined): Promise<Translator> {
  let fallbackLocale: Locale | undefined;
  if (isLocale(language)) {
    fallbackLocale = language;
  } else if (language !== undefined) {
    logger.warn(
      { language },
      'config.language is not a supported locale; registering command text in the default locale.',
    );
  }
  return createDefaultTranslator({ localesDir: resolveLocalesDir(), fallbackLocale });
}

function buildCommandsFromConfig(
  commands: string[],
  translator: Translator,
): ApplicationCommandDataResolvable[] {
  const out: ApplicationCommandDataResolvable[] = [];

  for (const name of commands) {
    const instance = createCommand(name);
    if (!instance || !instance.config) {
      logger.warn({ command: name }, 'Command could not be created or has no config.');
      continue;
    }

    // Command / option descriptions are i18n keys resolved here
    // against the `commands` catalog so the registered JSON keeps its
    // localised text.
    out.push(buildCommandJsonBody(localizeCommandConfig(instance.config, translator)));
  }

  return out;
}

async function registerGlobal(botName: string, keepGuildCommands: boolean): Promise<void> {
  const { token, clientId, commands, language } = loadBotConfig(botName);

  const translator = await buildRegisterTranslator(language);
  const body = buildCommandsFromConfig(commands, translator);
  if (body.length === 0) {
    logger.error('No commands to register (after filtering).');
    process.exit(1);
  }

  const rest = new REST({ version: '10' }).setToken(token);
  attachRateLimitLogger(rest);

  logger.info(
    { bot: botName, count: body.length, scope: 'global' },
    'Registering commands GLOBALLY (visible in every guild after Discord propagation, typically minutes).',
  );

  const res = (await rest.put(Routes.applicationCommands(clientId), {
    body,
  })) as unknown as { id: string }[];

  logger.info({ count: res.length }, 'Successfully registered global command(s).');

  // Prune any stale guild-scoped registrations so the freshly
  // registered global set is authoritative in every guild — otherwise
  // a leftover guild-scoped command (e.g. from a prior `--dev-guild`
  // run) overrides the global one there. Opt out with
  // `--keep-guild-commands` on large bots or when guild commands are
  // intentional.
  if (keepGuildCommands) {
    logger.info('Skipping guild-scoped command cleanup (--keep-guild-commands).');
    return;
  }
  await clearAllGuildCommands(rest, clientId);
}

async function registerDevGuild(botName: string, guildId: string): Promise<void> {
  const { token, clientId, commands, language } = loadBotConfig(botName);

  const translator = await buildRegisterTranslator(language);
  const body = buildCommandsFromConfig(commands, translator);
  if (body.length === 0) {
    logger.error('No commands to register (after filtering).');
    process.exit(1);
  }

  const rest = new REST({ version: '10' }).setToken(token);

  logger.info(
    { bot: botName, count: body.length, scope: 'guild', guildId },
    'Registering commands to dev guild (guild-scoped — instant propagation).',
  );

  const res = (await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body,
  })) as unknown as { id: string }[];

  logger.info({ count: res.length, guildId }, 'Successfully registered dev-guild command(s).');
}

/**
 * Build the command payload and print each command's resolved name and
 * description WITHOUT registering anything with Discord. Lets operators
 * confirm the per-bot `language` produces the expected localised text
 * locally, sidestepping global-command propagation delay (up to ~1h)
 * and stale guild-scoped registrations when debugging command text.
 */
async function registerDryRun(botName: string): Promise<void> {
  const { commands, language } = loadBotConfig(botName);
  const translator = await buildRegisterTranslator(language);
  const body = buildCommandsFromConfig(commands, translator);

  logger.info(
    { bot: botName, count: body.length, language: language ?? '(default)' },
    'Dry run — built command JSON locally; nothing registered with Discord.',
  );
  for (const cmd of body) {
    const c = cmd as { name?: string; description?: string };
    logger.info({ command: c.name, description: c.description }, 'resolved command');
  }
}

/**
 * Discord's per-route + global rate limits apply when walking guilds, so
 * the `rateLimited` listener surfaces throttling and this explicit
 * per-iteration delay paces the worst case under the 50 req/s global
 * ceiling. Increase it if a registration regularly hits the global limit.
 */
const PER_ITER_DELAY_MS = 250;

function attachRateLimitLogger(rest: REST): void {
  rest.on('rateLimited', (info) => {
    logger.warn(
      { route: info.route, timeoutMs: info.timeToReset, global: info.global },
      'Discord REST rate limit hit.',
    );
  });
}

/**
 * Clear guild-scoped command registrations from every guild the bot is
 * in by PUTting an empty array to each guild's command bucket. A
 * guild-scoped command otherwise overrides the global one in that guild,
 * so leftover registrations (e.g. from a prior `--dev-guild` run) keep
 * showing stale commands / text. Walks all guilds sequentially under the
 * rate limit — costly on bots with many hundreds of guilds.
 */
async function clearAllGuildCommands(rest: REST, clientId: string): Promise<void> {
  // Paginated: `Routes.userGuilds()` caps at 200 per page, so a single
  // request would silently miss guilds (and leave their commands) on
  // bots in more than 200 guilds.
  const guilds = await fetchAllUserGuilds(rest);

  logger.info(
    { guildCount: guilds.length },
    'Clearing guild-scoped commands so the global set is authoritative in every guild.',
  );
  if (guilds.length > 50) {
    logger.warn(
      { guildCount: guilds.length, perIterDelayMs: PER_ITER_DELAY_MS },
      'Large guild count; clearing guild-scoped commands sequentially under the rate limit (use --keep-guild-commands to skip).',
    );
  }

  for (const guild of guilds) {
    try {
      await rest.put(Routes.applicationGuildCommands(clientId, guild.id), { body: [] });
      logger.info({ guildName: guild.name, guildId: guild.id }, 'Cleared guild commands.');
    } catch (err) {
      logger.error(
        { guildId: guild.id, err: err instanceof Error ? err : new Error(String(err)) },
        'Failed to clear commands for guild.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, PER_ITER_DELAY_MS));
  }
}

async function cleanupGuildCommands(botName: string): Promise<void> {
  const { token, clientId } = loadBotConfig(botName);

  const rest = new REST({ version: '10' }).setToken(token);
  attachRateLimitLogger(rest);
  await clearAllGuildCommands(rest, clientId);

  logger.info('Cleanup done.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bot = args.bot;

  if (!bot) {
    logger.error(
      'Usage:\n' +
        '  yarn register -t <bot_name>                          # global (default)\n' +
        '  yarn register -t <bot_name> --dev-guild <guild_id>   # guild-side fast iteration\n' +
        '  yarn register -t <bot_name> --dry-run                # print resolved command text, register nothing\n' +
        '  yarn register -t <bot_name> --keep-guild-commands    # global registration WITHOUT pruning guild-scoped commands\n' +
        '  yarn register -t <bot_name> --cleanup-guild-commands # remove legacy guild-scoped commands',
    );
    process.exit(1);
  }

  try {
    if (args.dryRun === true) {
      await registerDryRun(bot);
    } else if (args.cleanupGuildCommands === true) {
      await cleanupGuildCommands(bot);
    } else if (args.devGuild !== undefined) {
      await registerDevGuild(bot, args.devGuild);
    } else {
      await registerGlobal(bot, args.keepGuildCommands === true);
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err : new Error(String(err)) },
      'Register CLI failed.',
    );
    process.exit(1);
  }
}

main();
