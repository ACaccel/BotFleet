/**
 * Argument parsing for the slash-command registration CLI.
 *
 * Two invocation shapes must resolve to the same options:
 *
 * - `npm run register -- -t nijika --dry-run`: everything after `--`
 *   reaches the script's argv verbatim.
 * - `npm run register -t nijika --dry-run`: npm consumes every flag it
 *   sees and exports it as `npm_config_<flag>` (`"true"` for a bare
 *   flag, the value for `--flag=value`), so only the flag's former value
 *   (`nijika`) is left in argv as a positional.
 *
 * Options therefore come from argv OR the npm flags. A bare `-t` /
 * `--dev-guild` consumed by npm leaves its value as a positional: a
 * snowflake positional is the dev guild, any other positional is the bot
 * name. Input that cannot be resolved to exactly one meaning is rejected
 * with a {@link RegisterUsageError} rather than guessed at.
 *
 * Kept free of I/O (bots and npm flags are passed in) so it is unit
 * tested without `register.ts` running its `main()` on import.
 */

/** npm flag names the register CLI reads (kebab-case CLI spelling). */
export const REGISTER_NPM_FLAGS = [
  't',
  'target',
  'b',
  'bot',
  'dev-guild',
  'dry-run',
  'keep-guild-commands',
  'cleanup-guild-commands',
] as const;

type RegisterNpmFlag = (typeof REGISTER_NPM_FLAGS)[number];

/** `npm_config_*` values npm set for {@link REGISTER_NPM_FLAGS}. */
export type RegisterNpmFlags = Readonly<Partial<Record<RegisterNpmFlag, string>>>;

export interface RegisterArgs {
  /** Target bot, or `undefined` to register every configured bot. */
  readonly bot: string | undefined;
  /** Guild for guild-scoped fast iteration; `undefined` registers globally. */
  readonly devGuild: string | undefined;
  readonly dryRun: boolean;
  readonly keepGuildCommands: boolean;
  readonly cleanupGuildCommands: boolean;
}

/** The input cannot be resolved to one unambiguous set of options. */
export class RegisterUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RegisterUsageError';
  }
}

export const REGISTER_USAGE = [
  'Usage:',
  '  npm run register                                          # every configured bot, global (default)',
  '  npm run register -t <bot_name>                            # one bot, global (default)',
  '  npm run register -t <bot_name> --dev-guild <guild_id>     # one bot, guild-side fast iteration',
  '  npm run register [-t <bot_name>] --dry-run                # print resolved command text, register nothing',
  '  npm run register [-t <bot_name>] --keep-guild-commands    # global WITHOUT pruning guild-scoped commands',
  '  npm run register [-t <bot_name>] --cleanup-guild-commands # only clear guild-scoped commands',
  'The `npm run register -- -t <bot_name> ...` form is still accepted.',
].join('\n');

/** Discord snowflakes are 17–20 decimal digits. */
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

const BOT_FLAGS: ReadonlySet<string> = new Set(['-t', '--target', '-b', '--bot']);
const NPM_BOT_FLAGS: readonly RegisterNpmFlag[] = ['t', 'target', 'b', 'bot'];
const DEV_GUILD_FLAG = '--dev-guild';

type BooleanOption = 'dryRun' | 'keepGuildCommands' | 'cleanupGuildCommands';

const BOOLEAN_FLAGS: Readonly<Record<string, BooleanOption>> = {
  '--dry-run': 'dryRun',
  '--keep-guild-commands': 'keepGuildCommands',
  '--cleanup-guild-commands': 'cleanupGuildCommands',
};

const NPM_BOOLEAN_FLAGS: Readonly<Record<BooleanOption, RegisterNpmFlag>> = {
  dryRun: 'dry-run',
  keepGuildCommands: 'keep-guild-commands',
  cleanupGuildCommands: 'cleanup-guild-commands',
};

/** npm exports `"true"` for a bare flag; `--flag=false` / `--no-flag` disable it. */
const NPM_BARE_FLAG = 'true';

const isNpmFlagValueSet = (value: string | undefined): value is string =>
  value !== undefined && value !== '' && value !== 'false';

interface ArgvScan {
  bot: string | undefined;
  devGuild: string | undefined;
  readonly booleans: Set<BooleanOption>;
  readonly positionals: string[];
}

/** Merge a value for one option from two sources, rejecting a conflict. */
const mergeValue = (
  current: string | undefined,
  next: string,
  option: string,
): string | undefined => {
  if (current !== undefined && current !== next) {
    throw new RegisterUsageError(`Conflicting ${option} values: "${current}" and "${next}".`);
  }
  return next;
};

/** Split `--flag=value` into its parts; a token without `=` has no inline value. */
const splitInlineValue = (token: string): { flag: string; inline: string | undefined } => {
  const eq = token.indexOf('=');
  return eq === -1
    ? { flag: token, inline: undefined }
    : { flag: token.slice(0, eq), inline: token.slice(eq + 1) };
};

const scanArgv = (argv: readonly string[]): ArgvScan => {
  const scan: ArgvScan = {
    bot: undefined,
    devGuild: undefined,
    booleans: new Set(),
    positionals: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (!token.startsWith('-')) {
      scan.positionals.push(token);
      continue;
    }

    const { flag, inline } = splitInlineValue(token);
    const booleanOption = BOOLEAN_FLAGS[flag];
    if (booleanOption !== undefined && inline === undefined) {
      scan.booleans.add(booleanOption);
      continue;
    }

    if (!BOT_FLAGS.has(flag) && flag !== DEV_GUILD_FLAG) {
      throw new RegisterUsageError(`Unknown option "${token}".`);
    }

    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        value = next;
        i++;
      }
    }
    if (value === undefined || value === '') {
      throw new RegisterUsageError(
        `Option "${flag}" requires a ${flag === DEV_GUILD_FLAG ? 'guild id' : 'bot name'}.`,
      );
    }

    if (flag === DEV_GUILD_FLAG) {
      scan.devGuild = mergeValue(scan.devGuild, value, '--dev-guild');
    } else {
      scan.bot = mergeValue(scan.bot, value, 'bot');
    }
  }

  return scan;
};

const assertKnownBot = (bot: string, knownBots: readonly string[]): string => {
  if (!knownBots.includes(bot)) {
    const known = knownBots.length > 0 ? knownBots.join(', ') : '(none found)';
    throw new RegisterUsageError(`Unknown bot "${bot}". Known bots: ${known}.`);
  }
  return bot;
};

const resolveBot = (
  scan: ArgvScan,
  npmFlags: RegisterNpmFlags,
  botPositionals: readonly string[],
  knownBots: readonly string[],
): string | undefined => {
  if (botPositionals.length > 1) {
    throw new RegisterUsageError(
      `Expected at most one bot name, got ${botPositionals.map((p) => `"${p}"`).join(', ')}.`,
    );
  }

  let bot = scan.bot;
  let botFlagConsumedByNpm = false;
  for (const flag of NPM_BOT_FLAGS) {
    const value = npmFlags[flag];
    if (!isNpmFlagValueSet(value)) continue;
    if (value === NPM_BARE_FLAG) {
      botFlagConsumedByNpm = true;
    } else {
      bot = mergeValue(bot, value, 'bot');
    }
  }

  const positional = botPositionals[0];
  if (positional !== undefined) {
    bot = mergeValue(bot, positional, 'bot');
  } else if (botFlagConsumedByNpm && bot === undefined) {
    throw new RegisterUsageError('Option "-t" requires a bot name.');
  }

  return bot === undefined ? undefined : assertKnownBot(bot, knownBots);
};

const resolveDevGuild = (
  scan: ArgvScan,
  npmFlags: RegisterNpmFlags,
  guildPositionals: readonly string[],
): string | undefined => {
  if (guildPositionals.length > 1) {
    throw new RegisterUsageError(
      `Expected at most one guild id, got ${guildPositionals.map((p) => `"${p}"`).join(', ')}.`,
    );
  }

  let devGuild = scan.devGuild;
  const npmValue = npmFlags['dev-guild'];
  const positional = guildPositionals[0];

  if (npmValue === NPM_BARE_FLAG) {
    if (positional === undefined) {
      throw new RegisterUsageError('Option "--dev-guild" requires a guild id.');
    }
    devGuild = mergeValue(devGuild, positional, '--dev-guild');
  } else {
    if (isNpmFlagValueSet(npmValue)) devGuild = mergeValue(devGuild, npmValue, '--dev-guild');
    if (positional !== undefined) {
      throw new RegisterUsageError(
        `Unexpected guild id "${positional}"; pass it as --dev-guild <guild_id>.`,
      );
    }
  }

  if (devGuild !== undefined && !SNOWFLAKE_PATTERN.test(devGuild)) {
    throw new RegisterUsageError(`Invalid --dev-guild "${devGuild}": expected a guild id.`);
  }
  return devGuild;
};

const resolveBoolean = (
  scan: ArgvScan,
  npmFlags: RegisterNpmFlags,
  option: BooleanOption,
): boolean => scan.booleans.has(option) || isNpmFlagValueSet(npmFlags[NPM_BOOLEAN_FLAGS[option]]);

/**
 * Resolve the register CLI options from argv and the npm flags.
 *
 * @param argv the script's arguments (`process.argv.slice(2)`).
 * @param npmFlags the `npm_config_*` values for {@link REGISTER_NPM_FLAGS}.
 * @param knownBots every bot personality directory; a bot name outside
 *   this list is rejected.
 * @throws {RegisterUsageError} when the input is unknown, incomplete, or
 *   ambiguous.
 */
export const parseRegisterArgs = (
  argv: readonly string[],
  npmFlags: RegisterNpmFlags,
  knownBots: readonly string[],
): RegisterArgs => {
  const scan = scanArgv(argv);
  const guildPositionals = scan.positionals.filter((p) => SNOWFLAKE_PATTERN.test(p));
  const botPositionals = scan.positionals.filter((p) => !SNOWFLAKE_PATTERN.test(p));

  const args: RegisterArgs = {
    bot: resolveBot(scan, npmFlags, botPositionals, knownBots),
    devGuild: resolveDevGuild(scan, npmFlags, guildPositionals),
    dryRun: resolveBoolean(scan, npmFlags, 'dryRun'),
    keepGuildCommands: resolveBoolean(scan, npmFlags, 'keepGuildCommands'),
    cleanupGuildCommands: resolveBoolean(scan, npmFlags, 'cleanupGuildCommands'),
  };

  if (args.devGuild !== undefined && args.bot === undefined) {
    throw new RegisterUsageError('--dev-guild registers one bot; pass -t <bot_name>.');
  }
  if (args.cleanupGuildCommands && args.devGuild !== undefined) {
    throw new RegisterUsageError('--cleanup-guild-commands cannot be combined with --dev-guild.');
  }
  if (args.cleanupGuildCommands && args.keepGuildCommands) {
    throw new RegisterUsageError(
      '--cleanup-guild-commands cannot be combined with --keep-guild-commands.',
    );
  }

  return args;
};
