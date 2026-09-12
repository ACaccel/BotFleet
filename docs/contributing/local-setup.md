# Local setup and development loop

Part of the [contributing guide](../../CONTRIBUTING.md).

## Prerequisites

- Node.js **>= 22.13** (see [`.nvmrc`](../../.nvmrc))
- Yarn 1 (classic) — `yarn install --frozen-lockfile`
- MongoDB for development (a free Atlas cluster works; integration
  tests use `mongodb-memory-server` and do not need a live database)

```bash
git clone git@github.com:ACaccel/BotFleet.git
cd BotFleet
yarn install --frozen-lockfile
```

## Per-personality configuration

Each personality under `src/bot/<name>/` ships a checked-in
`config.example.json`. Copy it and create the matching `.env`:

```bash
cp src/bot/nijika/config.example.json src/bot/nijika/config.json
# then write src/bot/nijika/.env (TOKEN, CLIENT_ID, ...)
```

Required env keys: `TOKEN`, `CLIENT_ID`. Optional: `MONGO_URI` (omit
for personalities that do not talk to Mongo), `PORT` (nijika's
earthquake webhook), and any LLM provider keys (`OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`). The full
schema lives in [`src/core/config/env.ts`](../../src/core/config/env.ts).

Notable `config.json` fields (shape: `Config` in
[`src/bot/index.ts`](../../src/bot/index.ts)):

- `admin` — optional `string[]` of Discord user ids with bot-admin
  privileges (e.g. `/ai_whitelist_*`, `/bug_report`). Snowflake ids
  must be JSON strings, e.g. `["671160708007854120"]`.
- `language` — optional default display locale, `"zh-TW"` (default) or
  `"en"`. An unsupported value logs a warning and falls back to the
  default.
- `guilds.<id>.channels` / `roles` — both optional. Omit a map (or the
  whole `guilds` block) to run without channel-bound side effects:
  debug logging and the guild-event mirror simply have nothing to send
  to. `tomori` ships with no `guilds` block for this reason.

## Running a personality

```bash
yarn nijika          # or konata / tomori / msg-archive
```

## Registering slash commands

Register slash commands with Discord (run after editing commands):

```bash
yarn deploy -t nijika                          # GLOBAL — register global set AND prune guild-scoped commands (propagation ~minutes, up to 1h)
yarn deploy -t nijika --dev-guild <guild_id>   # guild-scoped fast iteration (instant)
yarn deploy -t nijika --dry-run                # print resolved command name/description locally, register nothing
yarn deploy -t nijika --keep-guild-commands    # global deploy WITHOUT pruning guild-scoped commands
yarn deploy -t nijika --cleanup-guild-commands # only clear guild-scoped registrations
```

The default global deploy **prunes guild-scoped commands** from
every guild after registering the global set, so a stale guild-scoped
command (e.g. from a prior `--dev-guild` run) can no longer override the
global one in that guild. This walks every guild the bot is in under the
Discord rate limit; on bots with many hundreds of guilds, pass
`--keep-guild-commands` to skip the prune (or run it off-peak).

Command descriptions are localised to the bot's `config.language` (so
`"language": "en"` registers English text). When debugging command
text, `--dry-run` prints exactly what would be registered without
touching Discord, ruling out propagation delay (global takes up to an
hour) and guild-override effects.

The default is **global** registration so a freshly-invited guild
sees the full command set without an operator re-running deploy. Use
`--dev-guild` only while iterating on a test guild; production rolls
through the default global path.
