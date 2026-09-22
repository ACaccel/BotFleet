/**
 * Smoke check — boundary-integration sanity for a bot deployment.
 *
 * What it does (in order, each step timeboxed):
 *   1. `loadEnv()` from the target bot's `.env`. Catches misconfigured
 *      deployments before they reach the Discord login step.
 *   2. (Optional) `mongoose.createConnection(MONGO_URI)` + admin ping.
 *      Skipped when MONGO_URI is absent — some bots don't need Mongo.
 *   3. `discord.js` login with TOKEN, wait for the `ready` event, and
 *      verify the bot's user id matches CLIENT_ID. Catches token / id
 *      mismatch, intent rejections, and missing-network issues.
 *
 * What it does NOT do:
 *   - Register slash commands (`yarn register` is the canonical path).
 *   - Spin up plugins, web routes, or the BaseBot lifecycle. Smoke is
 *     a connectivity probe, not a full boot.
 *   - Send messages to a live guild. The previous plan considered a
 *     self-`/ping` round-trip; that requires a known guild + command,
 *     neither of which the smoke script should assume.
 *
 * Exit code is 0 on full success and 1 on any failure; the failure
 * step is printed to stderr so a CI / deployment pipeline can act on
 * it.
 *
 * Usage:
 *   yarn smoke              # defaults to --bot nijika
 *   yarn smoke --bot konata
 *   yarn smoke -b msg-archive
 *   SMOKE_TIMEOUT_MS=60000 yarn smoke --bot tomori
 */
import * as path from 'node:path';
import { Client, GatewayIntentBits } from 'discord.js';
import mongoose from 'mongoose';

import { loadEnv, type Env } from '../src/core/config/env';

interface CliOptions {
  readonly bot: string;
  readonly timeoutMs: number;
}

const DEFAULT_BOT = 'nijika';
const DEFAULT_TIMEOUT_MS = 30_000;

const parseArgs = (argv: readonly string[]): CliOptions => {
  let bot = DEFAULT_BOT;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if ((flag === '--bot' || flag === '-b') && argv[i + 1] !== undefined) {
      bot = argv[i + 1] as string;
      i += 1;
    }
  }
  const envOverride = process.env['SMOKE_TIMEOUT_MS'];
  const timeoutMs =
    envOverride === undefined ? DEFAULT_TIMEOUT_MS : Number.parseInt(envOverride, 10);
  if (Number.isNaN(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`SMOKE_TIMEOUT_MS must be a positive integer; got ${envOverride}`);
  }
  return { bot, timeoutMs };
};

/**
 * Race a promise against a manual timeout. We use this rather than
 * AbortController because both `mongoose.connect` and
 * `client.login(...)` short-circuit on their own timeouts that are
 * frequently longer than we want for a smoke probe.
 */
const withTimeout = async <T>(label: string, ms: number, work: () => Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`[smoke] step '${label}' timed out after ${ms}ms`));
    }, ms);
    // Allow the process to exit if the underlying work resolves but
    // the timer somehow leaks (paranoia for CI flake).
    timer.unref?.();
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const loadBotEnv = (botName: string): Env => {
  const envPath = path.resolve(process.cwd(), 'src', 'bot', botName, '.env');
  // `requireDb: false` — we want to surface a missing MONGO_URI as a
  // skipped step, not a load-time failure. The DB step decides per-bot
  // whether the URI is actually required (Konata/Tomori run without
  // Mongo today; Nijika and Msg-archive need it).
  return loadEnv({ envFile: envPath, requireDb: false, exitOnFailure: false });
};

const pingMongo = async (env: Env, timeoutMs: number): Promise<'ok' | 'skipped'> => {
  if (env.MONGO_URI === undefined) return 'skipped';
  return withTimeout('mongo', timeoutMs, async () => {
    const connection = await mongoose.createConnection(env.MONGO_URI as string).asPromise();
    try {
      const db = connection.getClient().db('admin');
      const pong = await db.command({ ping: 1 });
      if (pong['ok'] !== 1)
        throw new Error(`unexpected admin.ping response: ${JSON.stringify(pong)}`);
      return 'ok' as const;
    } finally {
      await connection.close();
    }
  });
};

const pingDiscord = async (env: Env, timeoutMs: number): Promise<void> => {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  return withTimeout('discord', timeoutMs, async () => {
    try {
      const ready = new Promise<void>((resolve) => {
        client.once('clientReady', () => resolve());
      });
      await client.login(env.TOKEN);
      await ready;
      const userId = client.user?.id;
      if (userId === undefined) throw new Error('client.user.id was undefined after ready event');
      if (userId !== env.CLIENT_ID) {
        throw new Error(
          `bot user id ${userId} does not match CLIENT_ID ${env.CLIENT_ID} from .env — wrong TOKEN?`,
        );
      }
    } finally {
      // destroy() is idempotent and safe to call even if login failed.
      await client.destroy();
    }
  });
};

const main = async (): Promise<void> => {
  const { bot, timeoutMs } = parseArgs(process.argv.slice(2));
  process.stdout.write(`[smoke] target=${bot} timeoutMs=${timeoutMs}\n`);

  process.stdout.write('[smoke] step 1/3: loading env... ');
  const env = loadBotEnv(bot);
  process.stdout.write(`ok (TOKEN=*** CLIENT_ID=${env.CLIENT_ID})\n`);

  process.stdout.write('[smoke] step 2/3: pinging Mongo... ');
  const mongoResult = await pingMongo(env, timeoutMs);
  process.stdout.write(`${mongoResult}\n`);

  process.stdout.write('[smoke] step 3/3: connecting Discord... ');
  await pingDiscord(env, timeoutMs);
  process.stdout.write('ready\n');

  process.stdout.write('[smoke] PASS\n');
};

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[smoke] FAIL: ${message}\n`);
  process.exit(1);
});
