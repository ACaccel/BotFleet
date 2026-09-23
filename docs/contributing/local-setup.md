# Local setup and development loop

Part of the [contributing guide](../../CONTRIBUTING.md).

## Prerequisites

- Conda / Miniforge; `environment.yml` supplies Node 22.13.0 and setup installs npm 10.9.2.
- MongoDB for development (a hosted instance works; integration tests use an isolated `mongodb-memory-server`).

```bash
git clone git@github.com:ACaccel/BotFleet.git
cd BotFleet
CONDA_EXE="$HOME/miniforge3/bin/conda" bash scripts/setup-env.sh
export PATH="$PWD/.conda/bin:$PATH"
```

The launcher selects `.conda` for application and verification commands.
Use the environment's npm from the PATH above; `conda activate` is optional.
Use `npm run install-lock` for locked installs (`npm ci`) through that runtime
and `npm run setup` to recreate/update the environment. Pass script arguments
after `--`, for example `npm run register -- -t nijika`.
Setup refuses changes while managed bot services are deployed. See
[systemd deployment](deployment.md) for production operations.

## Local Git hooks

Install the versioned hooks once per clone after reviewing any existing
Git hooks:

```bash
bash scripts/install-hooks.sh
```

The installer refuses to replace an existing hook path or custom hooks.
`pre-commit` checks staged whitespace, and `commit-msg` enforces the
[commit convention](branching-and-releases.md#commit-conventions).
`pre-push` runs the full local [quality gates](../../CONTRIBUTING.md#quality-gates)
when pushing a clean, checked-out commit to `dev`; it does not rerun the
plain test command because coverage already runs all six projects. GitHub
CI remains the final signal after the push.

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
npm run nijika          # or konata / tomori / msg-archive
```

## Registering slash commands

Register slash commands with Discord (run after editing commands):

```bash
npm run register -- -t nijika                          # GLOBAL — register global set AND prune guild-scoped commands (propagation ~minutes, up to 1h)
npm run register -- -t nijika --dev-guild <guild_id>   # guild-scoped fast iteration (instant)
npm run register -- -t nijika --dry-run                # print resolved command name/description locally, register nothing
npm run register -- -t nijika --keep-guild-commands    # global deploy WITHOUT pruning guild-scoped commands
npm run register -- -t nijika --cleanup-guild-commands # only clear guild-scoped registrations
```

The default global registration **prunes guild-scoped commands** from
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
sees the full command set without an operator re-running register. Use
`--dev-guild` only while iterating on a test guild; production rolls
through the default global path.
