/**
 * Slash-command registration CLI. Flags and usage: `REGISTER_USAGE` in
 * `register-args.ts` and `docs/contributing/local-setup.md`.
 *
 * Registration is global by default, because one
 * `Routes.applicationCommands` PUT covers every current and future guild.
 * Global propagation can take up to an hour, so `--dev-guild <id>` registers
 * on one guild for instant iteration.
 *
 * A global run also clears guild-scoped registrations from every guild, so a
 * stale one (e.g. from a `--dev-guild` run) cannot shadow or duplicate the
 * global command; `--keep-guild-commands` skips that step when guild-scoped
 * commands are intentional.
 *
 * Without `-t`, every bot under `src/bot/` with both `config.json` and `.env`
 * is registered in turn. One bot failing does not stop the rest; the process
 * exits 1 after a per-bot summary if any failed. Command text is localised
 * to the bot's `config.language` (see `buildRegisterTranslator`).
 */
import { REST, Routes } from 'discord.js';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

import { createBootstrapLogger, loadEnv, readNpmConfigFlags } from '@core/config';
import { createDefaultTranslator, isLocale, type Locale, type Translator } from '@core/i18n';

import { resolveLocalesDir } from './bot/locales-dir';
import {
  parseRegisterArgs,
  REGISTER_NPM_FLAGS,
  REGISTER_USAGE,
  RegisterUsageError,
  type RegisterArgs,
} from './register-args';
import {
  BOT_CONFIG_FILE,
  BOT_ENV_FILE,
  runForEachBot,
  scanBotDirectories,
  type BotDirectoryScan,
} from './register-batch';
import { buildCommandsFromConfig } from './register-commands';
import { fetchAllUserGuilds } from './register-guilds';

// Register runs before the IoC container is built, so the typed `Logger`
// bound to `TOKENS.Logger` is not available. Use the bootstrap logger
// (the same construct `BaseBot.run()` falls back to during phase 1)
// so the register CLI still emits structured pino lines instead of raw
// `console.*` writes. `fileRouter: false` keeps it console-only: register
// is a one-shot CLI with no `bot` binding (which the file router
// requires) and must not create a `logs/<botId>/` tree.
//
// Log fields name the bot `target`, not `bot`: the pretty console format
// hides `bot` (a process-wide binding in a running bot), which would
// leave an all-bots run's lines unattributed.
const logger = createBootstrapLogger({ component: 'register' }, { fileRouter: false });

type BotConfig = {
  commands?: string[];
  language?: string;
};

const BOT_ROOT = path.resolve(__dirname, 'bot');

function resolveBotPaths(botName: string) {
  const baseDir = path.join(BOT_ROOT, botName);
  const configPath = path.join(baseDir, BOT_CONFIG_FILE);
  const envPath = path.join(baseDir, BOT_ENV_FILE);

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
  config: BotConfig;
} {
  const { configPath, envPath } = resolveBotPaths(botName);

  // Parse the bot's own `.env` instead of loading it into `process.env`:
  // an all-bots run registers several bots in one process, and dotenv
  // never overwrites a key already set, so every later bot would
  // otherwise reuse the first bot's TOKEN / CLIENT_ID.
  const env = loadEnv({
    exitOnFailure: false,
    requireDb: false,
    source: dotenv.parse(fs.readFileSync(envPath)),
  });
  const token = env.TOKEN;
  const clientId = env.CLIENT_ID;

  const raw = fs.readFileSync(configPath, 'utf8');
  const cfg = JSON.parse(raw) as BotConfig;

  if (!cfg.commands || !Array.isArray(cfg.commands) || cfg.commands.length === 0) {
    throw new Error(`No commands defined in ${configPath}`);
  }

  return { token, clientId, commands: cfg.commands, language: cfg.language, config: cfg };
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

async function registerGlobal(botName: string, keepGuildCommands: boolean): Promise<void> {
  const { token, clientId, commands, language, config } = loadBotConfig(botName);

  const translator = await buildRegisterTranslator(language);
  const body = buildCommandsFromConfig(commands, translator, config, logger);
  if (body.length === 0) {
    throw new Error(`No commands to register for ${botName} (after filtering).`);
  }

  const rest = new REST({ version: '10' }).setToken(token);
  attachRateLimitLogger(rest);

  logger.info(
    { target: botName, count: body.length, scope: 'global' },
    'Registering commands GLOBALLY (visible in every guild after Discord propagation, typically minutes).',
  );

  const res = (await rest.put(Routes.applicationCommands(clientId), {
    body,
  })) as unknown as { id: string }[];

  logger.info({ target: botName, count: res.length }, 'Successfully registered global command(s).');

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
  const { token, clientId, commands, language, config } = loadBotConfig(botName);

  const translator = await buildRegisterTranslator(language);
  const body = buildCommandsFromConfig(commands, translator, config, logger);
  if (body.length === 0) {
    throw new Error(`No commands to register for ${botName} (after filtering).`);
  }

  const rest = new REST({ version: '10' }).setToken(token);

  logger.info(
    { target: botName, count: body.length, scope: 'guild', guildId },
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
  const { commands, language, config } = loadBotConfig(botName);
  const translator = await buildRegisterTranslator(language);
  const body = buildCommandsFromConfig(commands, translator, config, logger);

  logger.info(
    { target: botName, count: body.length, language: language ?? '(default)' },
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

  logger.info({ target: botName }, 'Cleanup done.');
}

function registerBot(botName: string, args: RegisterArgs): Promise<void> {
  if (args.dryRun) return registerDryRun(botName);
  if (args.cleanupGuildCommands) return cleanupGuildCommands(botName);
  if (args.devGuild !== undefined) return registerDevGuild(botName, args.devGuild);
  return registerGlobal(botName, args.keepGuildCommands);
}

/** The bots this run covers: the named one, or every configured bot. */
function selectTargets(args: RegisterArgs, scan: BotDirectoryScan): readonly string[] {
  if (args.bot !== undefined) return [args.bot];

  if (scan.skipped.length > 0) {
    logger.warn(
      { skipped: scan.skipped.map((s) => `${s.bot} (missing ${s.missing.join(', ')})`) },
      'Skipping bots without config.json and .env.',
    );
  }
  logger.info({ bots: scan.configured }, 'No target bot given; registering every configured bot.');
  return scan.configured;
}

async function main(): Promise<void> {
  const scan = scanBotDirectories(BOT_ROOT);

  let args: RegisterArgs;
  try {
    args = parseRegisterArgs(
      process.argv.slice(2),
      readNpmConfigFlags(REGISTER_NPM_FLAGS),
      scan.known,
    );
  } catch (err) {
    if (!(err instanceof RegisterUsageError)) throw err;
    logger.error(`${err.message}\n${REGISTER_USAGE}`);
    process.exitCode = 1;
    return;
  }

  const targets = selectTargets(args, scan);
  if (targets.length === 0) {
    logger.error({ botRoot: BOT_ROOT }, 'No configured bots found to register.');
    process.exitCode = 1;
    return;
  }

  const { outcomes, exitCode } = await runForEachBot(
    targets,
    (bot) => registerBot(bot, args),
    (bot, err) => logger.error({ target: bot, err }, 'Register CLI failed for bot.'),
  );

  for (const outcome of outcomes) {
    if (outcome.ok) {
      logger.info({ target: outcome.bot, result: 'ok' }, 'Register summary.');
    } else {
      logger.error(
        { target: outcome.bot, result: 'failed', reason: outcome.error.message },
        'Register summary.',
      );
    }
  }
  process.exitCode = exitCode;
}

main().catch((err: unknown) => {
  logger.error(
    { err: err instanceof Error ? err : new Error(String(err)) },
    'Register CLI failed.',
  );
  process.exitCode = 1;
});
