# Operations

Part of the [contributing guide](../../CONTRIBUTING.md). Covers the
pre-deploy smoke check and the dependency-override policy.

## Host migration

The [migration tool runbook](../../tools/migration/README.md) owns host setup,
database transfer, runtime validation and cutover instructions.

## Recording removal rollout

Recording is no longer supported. When upgrading a deployment that used
`/record`, remove `record` from each affected bot's `config.json` commands
list, stop the old process, and start the updated bot. Republish the affected
bots' Discord command lists using the [command registration procedure](local-setup.md#registering-slash-commands)
to remove the existing `/record` registration. Review its guild-command
pruning behavior before deploying; updating source files alone does not
change Discord registrations.

Existing recordings under `data/voice_record` remain on disk. Bootstrap no
longer installs FFmpeg; it does not uninstall FFmpeg from an existing host.
Voice and stage channel text-message backups remain supported.

## Pre-deploy smoke

`npm run smoke` is a boundary-only sanity check intended to run against a
staging or production deployment **before** promoting a release. It
needs a real bot `.env` (TOKEN + CLIENT_ID, plus MONGO_URI for bots
that talk to Mongo) and live network access to Discord.

```bash
npm run smoke                 # defaults to --bot nijika
npm run smoke -- --bot konata
npm run smoke -- -b msg-archive
SMOKE_TIMEOUT_MS=60000 npm run smoke -- --bot tomori
```

What the script verifies, in order:

1. **Env load** — runs the same zod-parsed `loadEnv()` the bot uses at
   boot, so a missing or malformed value fails fast.
2. **Mongo `admin.ping`** — only if `MONGO_URI` is present in the
   loaded env. Confirms authentication and reachability without
   touching any guild database.
3. **Discord login + `clientReady`** — logs the bot in with TOKEN,
   waits for the ready event, and asserts the bot's user id matches
   `CLIENT_ID`.

Each step is timeboxed (default 30 s, override via `SMOKE_TIMEOUT_MS`).
The script does NOT register slash commands, start plugins, or open
HTTP routes — keep it cheap so it can sit in front of every deploy.
Exit status: `0` on full success, `1` on any failure (the failed step
is printed to stderr).

## Dependency overrides

`package.json` carries a single `overrides` entry:

- **`undici: ^6.27.0`** — `discord.js` depends on `undici` at an exact
  pin (`6.24.1`), which sits below the fix for the advisory `npm run security` reports. Because the pin is exact, nothing else in the tree
  can lift it; the override is required. Re-verify it on every
  `discord.js` bump: if the new release pins a version at or above the
  override, drop the entry rather than leaving an override that no
  longer does anything.

An override that merely restates what the dependency's own range
already permits is dead weight — it hides which overrides are
load-bearing. Check with `npm explain <pkg>` before adding one.

## Database recovery

After startup or guild onboarding exhausts its connection retries, transient
network failures and timeouts are retried in the background. Configure
`MONGO_RECOVERY_INTERVAL_MS` in the bot environment (default `60000`, positive
integer no greater than `2147483647`). It controls the recovery polling interval
and the per-guild cooldown after failed attempts. Passes do not overlap.
Authentication, authorization and other persistent errors remain disabled;
correct the cause and restart the bot.

Recovered repositories are attached before the guild database-ready plugin hook
runs. Giveaway, activity and temporary-role jobs are rebuilt only for that guild;
healthy guilds are not replayed. Shutdown cancels recovery and prevents in-flight
attempts from publishing new repositories. Giveaway failures display the database
error ID, which can be matched to the connection log.

A refused TCP connection means the configured Mongo endpoint is not accepting
connections. Restore the database service or network route first; restarting the
bot alone cannot repair that failure. Deploy this recovery code and restart the
bot once to activate it; later transient startup failures recover automatically.
