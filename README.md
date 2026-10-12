# BotFleet

A multi-personality Discord bot framework built with TypeScript, discord.js and MongoDB.
Each bot runs independently and selects features from a shared plugin system.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](tsconfig.strict.json)

## Features

- Slash commands and interactive components, with English and Traditional Chinese replies.
- LLM chat through OpenAI, Anthropic, Gemini and xAI, plus self-hosted auto-replies.
- Message archives, activity reports, giveaways and temporary roles.
- [Temporary moderation](docs/contributing/operations.md#temporary-moderation) with automatic reply suppression.
- [Thread moderation](docs/thread-moderation.md) on Nijika, with paginated ban lists, delegated management approved by DM, and deletion of attributable public bot replies.
- Social-link previews and channel subscriptions to social feeds.
- Earthquake notifications and plugin-owned scheduled jobs.

## Built-in personalities

| Bot           | Run                   | Purpose                                                               |
| ------------- | --------------------- | --------------------------------------------------------------------- |
| `nijika`      | `npm run nijika`      | Interactive features, social feeds and an earthquake webhook          |
| `konata`      | `npm run konata`      | Interactive bot                                                       |
| `tomori`      | `npm run tomori`      | Public-facing interactive bot                                         |
| `msg-archive` | `npm run msg-archive` | Message-backup worker                                                 |
| `gopher`      | `npm run gopher`      | Database-free self-hosted LLM replies, settings API and identity sync |

## Quick start

Requires Conda / Miniforge and, for persistent features, MongoDB. Setup installs
the pinned Node/npm runtime and native dependencies into the project's `.conda`.

```bash
git clone https://github.com/ACaccel/BotFleet.git
cd BotFleet
CONDA_EXE="$HOME/miniforge3/bin/conda" bash scripts/setup-env.sh
export PATH="$PWD/.conda/bin:$PATH"
cp src/bot/nijika/config.example.json src/bot/nijika/config.json
```

Edit `config.json` with your Discord IDs and desired commands, removing unused
placeholder entries. Create `src/bot/nijika/.env` with `TOKEN`, `CLIENT_ID`,
`MONGO_URI` and `PORT`. See [Configuration](docs/configuration.md) for other bots
and feature requirements. Keep both local files out of version control.

```bash
npm run register -t nijika --dry-run
npm run register -t nijika
npm run nijika
```

Registration updates Discord's global commands and **prunes guild-scoped commands**.
`npm run register` without `-t` registers every bot that has both `config.json` and `.env`.
Use the [local setup guide](docs/contributing/local-setup.md) for test-guild
registration, Git hooks and the development loop.

## Configuration

[Configuration reference](docs/configuration.md) covers environment variables,
per-bot feature settings, channel privacy and attachment storage.
Start with the `config.example.json` in your bot's directory.

Upgrading an older installation? See [Upgrade notes](docs/upgrading.md) for
retired features and configuration migrations.

## Documentation

See the [documentation index](docs/README.md) for all guides.

| Task                                            | Guide                                          |
| ----------------------------------------------- | ---------------------------------------------- |
| Deploy or update systemd services               | [Deployment](docs/contributing/deployment.md)  |
| Diagnose database or connectivity problems      | [Operations](docs/contributing/operations.md)  |
| Move to another host                            | [Migration runbook](tools/migration/README.md) |
| Understand the system                           | [Architecture](docs/architecture.md)           |
| Develop commands or plugins; run quality checks | [Contributing](CONTRIBUTING.md)                |
| Review releases                                 | [Changelog](CHANGELOG.md)                      |

`npm run register` updates Discord commands; `npm run deploy` manages systemd
services. Deployment does not register commands.

## License

[MIT](LICENSE).

### Message archival

[msg-archive](docs/message-archive.md) exclusively captures and reconciles guild
messages, observed edits (up to 50 previous versions per message), deletions and
complete normal/burst reaction memberships. Archive records store attachment
metadata and unsigned CDN locations without downloading files; existing
event-deletion attachment archives remain unchanged. Bot/webhook source allowlists
default to empty; an unlisted bot's interaction replies keep only an interaction
record for command statistics. Administrators in msg-archive's `admin` list control it through
[`/archive`](docs/message-archive.md#discord-controls) in each guild's debug channel:

- `/archive backup` starts a [full backup](docs/message-archive.md#full-backup) after
  one confirmation. It uses a fixed cutoff and per-channel checkpoints, can be
  stopped and resumed, continues after a restart, and completes with known gaps
  listed. A public panel follows its progress every ten seconds.
- `/archive status` shows the full backup, periodic backup, coverage, live capture
  and capacity in one panel, with gap details and recent records.
- `/archive schedule [enabled] [minutes]` shows or changes periodic backup, which
  defaults to disabled. Periodic passes are incremental, pause while a full backup
  runs, and post to the debug channel only after three consecutive failures and on
  recovery.

Archive work uses bounded batches and history prefetch with durable checkpoints.
One message whose reaction list cannot be confirmed is marked stale instead of
failing its page. Developer performance measurements and their limits are recorded
in the [benchmark report](docs/contributing/archive-performance-results.md).

Any bot can enable the read-only `/traffic` reports on the archive: `overview`,
`channel`, `me`, `user`, `apps`, `emoji` and `sticker`, each one embed with a
landscape dashboard image (see [activity reports](docs/message-archive.md#activity-reports)).

Related slash commands are grouped under `/feed`, `/reply`, `/activity`,
`/giveaway`, `/ai`, `/thread`, and `/traffic`. Use `/help` for executable paths;
see the [command migration table](docs/upgrading.md#grouped-slash-commands) when upgrading.
