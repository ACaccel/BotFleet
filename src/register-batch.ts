/**
 * Bot discovery and the per-bot batch runner for the register CLI.
 *
 * `npm run register` without a target registers every configured bot.
 * Discovery finds the personality directories under `src/bot/`; the
 * runner registers them one after another and isolates failures so one
 * misconfigured bot cannot stop the rest.
 *
 * Kept in its own module (not inline in `register.ts`) so it can be unit
 * tested without `register.ts` running its `main()` on import.
 */
import fs from 'fs';
import path from 'path';

/** Per-bot files registration needs; a bot missing either is skipped. */
export const BOT_CONFIG_FILE = 'config.json';
export const BOT_ENV_FILE = '.env';

/**
 * A directory under `src/bot/` is a bot personality when it carries an
 * entry module (`index.ts` under ts-node, `index.js` in an emitted
 * build); shared composition code lives in plain files beside them.
 */
const BOT_ENTRY_FILES: readonly string[] = ['index.ts', 'index.js'];

interface SkippedBot {
  readonly bot: string;
  /** The required files absent from the bot's directory. */
  readonly missing: readonly string[];
}

export interface BotDirectoryScan {
  /** Every bot personality, configured or not, sorted by name. */
  readonly known: readonly string[];
  /** Personalities with both {@link BOT_CONFIG_FILE} and {@link BOT_ENV_FILE}. */
  readonly configured: readonly string[];
  /** Personalities missing at least one required file. */
  readonly skipped: readonly SkippedBot[];
}

/** List the bot personalities under `botRoot` and split them by readiness. */
export const scanBotDirectories = (botRoot: string): BotDirectoryScan => {
  const known = fs
    .readdirSync(botRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => BOT_ENTRY_FILES.some((file) => fs.existsSync(path.join(botRoot, name, file))))
    .sort();

  const configured: string[] = [];
  const skipped: SkippedBot[] = [];
  for (const bot of known) {
    const missing = [BOT_CONFIG_FILE, BOT_ENV_FILE].filter(
      (file) => !fs.existsSync(path.join(botRoot, bot, file)),
    );
    if (missing.length === 0) {
      configured.push(bot);
    } else {
      skipped.push({ bot, missing });
    }
  }

  return { known, configured, skipped };
};

type BotRunOutcome =
  | { readonly bot: string; readonly ok: true }
  | { readonly bot: string; readonly ok: false; readonly error: Error };

export interface BotBatchResult {
  readonly outcomes: readonly BotRunOutcome[];
  /** `1` when any bot failed, else `0`. */
  readonly exitCode: 0 | 1;
}

/**
 * Run `run` for each bot sequentially, recording every failure instead
 * of stopping at the first one.
 *
 * Sequential rather than parallel: each registration walks Discord's
 * rate-limited routes, and interleaved per-bot logs would be unreadable.
 * `onFailure` is invoked as each failure happens so the caller can log
 * it in context before the next bot starts.
 */
export const runForEachBot = async (
  bots: readonly string[],
  run: (bot: string) => Promise<void>,
  onFailure?: (bot: string, error: Error) => void,
): Promise<BotBatchResult> => {
  const outcomes: BotRunOutcome[] = [];
  for (const bot of bots) {
    try {
      await run(bot);
      outcomes.push({ bot, ok: true });
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      onFailure?.(bot, error);
      outcomes.push({ bot, ok: false, error });
    }
  }
  return { outcomes, exitCode: outcomes.every((o) => o.ok) ? 0 : 1 };
};
