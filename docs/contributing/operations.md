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

`yarn smoke` is a boundary-only sanity check intended to run against a
staging or production deployment **before** promoting a release. It
needs a real bot `.env` (TOKEN + CLIENT_ID, plus MONGO_URI for bots
that talk to Mongo) and live network access to Discord.

```bash
yarn smoke                 # defaults to --bot nijika
yarn smoke --bot konata
yarn smoke -b msg-archive
SMOKE_TIMEOUT_MS=60000 yarn smoke --bot tomori
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

`package.json` carries a single `resolutions` entry:

- **`undici: ^6.27.0`** — `discord.js` depends on `undici` at an exact
  pin (`6.24.1`), which sits below the fix for the advisory `yarn
security` reports. Because the pin is exact, nothing else in the tree
  can lift it; the resolution is the only lever. Re-verify it on every
  `discord.js` bump: if the new release pins a version at or above the
  override, drop the entry rather than leaving a resolution that no
  longer does anything.

A resolution that merely restates what the dependency's own range
already permits is dead weight — it hides which overrides are
load-bearing. Check with `yarn why <pkg>` before adding one.
