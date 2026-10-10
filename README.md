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
npm run register -- -t nijika --dry-run
npm run register -- -t nijika
npm run nijika
```

Registration updates Discord's global commands and **prunes guild-scoped commands**.
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
messages, observed edits/deletions and complete normal/burst reaction memberships.
New archive records store attachment metadata without downloading files; existing
event-deletion attachment archives remain unchanged. Bot/webhook source allowlists
default to empty. The worker supports bounded scans, progress/ETA and reviewed,
resumable database repair through [Discord archive controls](docs/message-archive.md#discord-controls). Periodic
scans default to disabled; enable them per guild with
[`/archive schedule enable minutes:60`](docs/message-archive.md#periodic-schedule)
after initial repair to set the interval and enable backup together.

Start a [one-shot backup](docs/message-archive.md#one-shot-repair) with
`/archive backup`: review the change summary, confirm the backup, then accept its
verified result. A public status card refreshes every ten seconds and offers
**View details** and cooperative stopping. Pages use at most five buttons and no
select menus. Lists show two entries per page with item buttons, refresh,
next-page controls and **Delete all jobs** or **Delete all plans**. List, item and confirmation navigation stays in the clicked
message, so separate panels do not overwrite each other. Small plans show concrete changes; larger plans show grouped
impacts with source examples. Eligible deletion and rollback appear directly on
the item panel; running jobs must stop before deletion. Apply, resume and acceptance
open their confirmation directly. Whole-list deletion opens an
[all-pages review](docs/message-archive.md#bulk-deletion) before confirmation;
running jobs stop cooperatively. Unused, never-applied or fully rolled-back plans
without conflicts or recovery journals can be deleted; plans with remaining
applied changes or active work remain protected.
Active-only filters are omitted.
`/archive schedule` manages automatic scans. Deleting control records preserves
archived messages.
Selected plans show the associated backup progress above their summary, with
**Update progress** and **Pause backup** controls. Pausing preserves completed
work; eligible backups resume through the same plan.

Archive work uses bounded batches and history prefetch with durable checkpoints.
One-shot conditional writes use indexed identity lookup; both one-shot and periodic
scans combine trusted empty reaction publication with snapshot writes. Bounded
journal/write batches retain conflict checks, cancellation and rollback.
Shared [progress reports](docs/message-archive.md#progress-and-access) distinguish
content updates, legacy format upgrades, completed reaction lists and coverage gaps.
They separate saved checkpoints from notification delivery and show recent throughput
without counting restored progress as new work. Partial one-shot results
identify stopped work and direct users to review the existing run before resuming.
Routine cards include one current-activity line with the source, processing step
and available page or reaction membership counts, refreshed every ten seconds.
They show the next action without duplicate counters. Repeating saved schedule settings does not restart
or postpone backup.
Developer performance
measurements and their limits are recorded in the
[benchmark report](docs/contributing/archive-performance-results.md).

Related slash commands are grouped under `/feed`, `/reply`, `/activity`,
`/giveaway`, `/ai`, `/thread`, and `/traffic`. Use `/help` for executable paths;
see the [command migration table](docs/upgrading.md#grouped-slash-commands) when upgrading.
