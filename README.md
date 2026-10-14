# BotFleet

A multi-personality Discord bot framework built with TypeScript, discord.js and MongoDB.
Each bot runs as its own process and composes its features from a shared plugin
system, with English and Traditional Chinese replies throughout.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](tsconfig.strict.json)

## Bots

Each bot is a composition root under [`src/bot/<bot>/`](src/bot/) that extends the
shared `BaseBot` and registers its own plugins and services.

| Bot           | Run                   | Required environment                      | What the implementation wires                                                                                                                                                                                                       |
| ------------- | --------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nijika`      | `npm run nijika`      | `TOKEN`, `CLIENT_ID`, `MONGO_URI`, `PORT` | Automatic replies, event mirroring, social-link previews, giveaways, activities and temporary roles, plus social-feed polling with its platform registry, an earthquake webhook and CWA earthquake reports (optional `CWA_API_KEY`) |
| `tomori`      | `npm run tomori`      | `TOKEN`, `CLIENT_ID`, `MONGO_URI`         | Automatic replies, event mirroring, social-link previews, giveaways, activities and temporary roles                                                                                                                                 |
| `konata`      | `npm run konata`      | `TOKEN`, `CLIENT_ID`, `MONGO_URI`         | LLM chat for whitelisted users (a mention starts a session, a reply continues it) and an online presence; the guild-join listener is off                                                                                            |
| `gopher`      | `npm run gopher`      | `TOKEN`, `CLIENT_ID`, `PORT`              | Self-hosted LLM auto-replies, a settings REST API that swaps the LLM endpoint at runtime, and daily avatar/nickname sync; no database                                                                                               |
| `msg-archive` | `npm run msg-archive` | `TOKEN`, `CLIENT_ID`, `MONGO_URI`         | The only [message archive](docs/message-archive.md) writer: live capture, periodic and full backups, and archive control; it exposes exactly `/archive`                                                                             |

Event mirroring posts message edits, deletions and role changes to a guild's event
channel and keeps deleted attachments through an attachment cache. LLM providers,
the settings API and nijika's [earthquake reports](docs/configuration.md#earthquake-alerts-and-reports)
need their own keys; see
[environment variables](docs/configuration.md#environment-variables).

Every bot shares the framework capabilities:

- Any registered slash command can be enabled per bot through its command list,
  except on msg-archive, which always exposes exactly `/archive`. A command that
  depends on a service the bot does not wire cannot run there; `/archive`, for
  example, needs msg-archive's archive control.
- [Thread moderation](docs/thread-moderation.md) is a per-bot option that requires
  MongoDB.
- Replies are localized in English or Traditional Chinese, selected per bot.

## Features

- **Slash commands and components.** Commands, context menus, buttons, modals and
  select menus, with shared [state-based embed colors](docs/architecture.md#discord-presentation-colors).
- **LLM integration.** Chat through OpenAI, Anthropic, Gemini and xAI, with the
  user whitelist and settings managed through `/ai`, configurable
  [model and usage limits](docs/configuration.md#ai-models-and-usage-limits),
  and self-hosted auto-replies.
- **Moderation.** [Temporary moderation](docs/contributing/operations.md#temporary-moderation)
  through `/ban_user` votes with automatic reply suppression, and
  [thread moderation](docs/thread-moderation.md) with paginated ban lists,
  delegated management approved by DM and deletion of attributable bot replies.
- **Community tools.** Giveaways, activities, temporary notification roles,
  role-claim messages, level roles and restaurant picks. `/give_score` and `/gay`
  give stable daily readings in the bot's configured time zone, with member and
  pair options and mention-safe replies.
- **Social media.** Rich previews for shared links and per-channel subscriptions to
  social feeds. X links and subscriptions use custom cards for text and photos,
  proxies for playable videos, and bounded video uploads as a fallback.
  Facebook uses custom cards with truncated text, complete image galleries and separate video
  attachments and engagement counts when available; the title links to the post,
  and failed video delivery falls back to a link. See
  [preview configuration](docs/configuration.md#social-previews-and-feeds).
- **Message archive.** msg-archive captures messages, edits (up to 50 previous
  versions), deletions and complete reaction memberships. Administrators run a
  resumable [full backup](docs/message-archive.md#full-backup) after one
  confirmation, check status and set the
  [periodic schedule](docs/message-archive.md#periodic-schedule) (disabled by
  default) from the guild's debug channel.
- **Activity reports.** Any bot can enable the read-only
  [`/traffic` dashboards](docs/message-archive.md#activity-reports) on the archive:
  dashboard images in embeds (two for the activity reports), public unless requested
  otherwise.
- **Command logs.** Compact debug-channel embeds show the full command name,
  user and channel mentions, and execution time. See
  [configuration](docs/configuration.md#common-bot-settings).

## Requirements

- Conda or Miniforge. [`scripts/setup-env.sh`](scripts/setup-env.sh) installs
  into the project's `.conda` the pinned Node.js 22.13 runtime and the CJK and colour
  emoji fonts used by dashboard images; it then installs the locked npm dependencies
  and verifies Canvas (see [local setup](docs/contributing/local-setup.md#prerequisites)).
- MongoDB for every bot except gopher. Integration tests use an in-memory server.
- A Discord application per bot, plus provider API keys for the features you enable.

## Quick start

```bash
git clone https://github.com/ACaccel/BotFleet.git
cd BotFleet
CONDA_EXE="$HOME/miniforge3/bin/conda" bash scripts/setup-env.sh
export PATH="$PWD/.conda/bin:$PATH"
cp src/bot/nijika/config.example.json src/bot/nijika/config.json
```

Edit `config.json` with your Discord IDs and the commands to expose, removing
unused placeholder entries. Create `src/bot/nijika/.env` with `TOKEN`, `CLIENT_ID`,
`MONGO_URI` and `PORT`. Keep both files out of version control. The
[configuration reference](docs/configuration.md) covers the other bots, every
environment variable and each feature's settings.

```bash
npm run register -t nijika --dry-run   # preview the commands
npm run register -t nijika             # register one bot
npm run nijika
```

`npm run register` without `-t` registers every bot that has both `config.json` and
`.env`. Global registration **prunes guild-scoped commands**; see
[registering slash commands](docs/contributing/local-setup.md#registering-slash-commands)
for test-guild registration and the opt-out flags. Registration is separate from
[deployment](docs/contributing/deployment.md), which runs the bots as systemd services.

## Commands

A bot exposes only the command IDs listed in its `config.json` `commands`. Related
actions are grouped under one root. `/help` shows a private root-command overview
with a category selector; `/help command:<name>` lists that command's paths and
options. Admin-only paths are hidden from non-admins.

| Area              | Commands                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| Grouped roots     | `/activity`, `/ai`, `/feed`, `/giveaway`, `/reply`, `/role`, `/thread`, `/traffic`, `/archive` |
| Activity reports  | `/traffic overview`, `channel`, `me`, `user`, `apps`, `emoji`, `sticker`                       |
| Server and roles  | `/role`, `/level_detail`, `/roll_call`, `/ban_user`                                            |
| Bot persona       | `/talk`, `/change_avatar`                                                                      |
| Utilities and fun | `/help`, `/bug_report`, `/random_restaurant`, `/give_score`, `/gay`                            |
| Context menus     | Get avatar, get sticker                                                                        |

Upgrading from standalone commands such as `/feed_subscribe`, or from the removed
`/emoji_frequency`, `/sticker_frequency` and `/db_list_message`? See
[grouped slash commands](docs/upgrading.md#grouped-slash-commands) and
[message statistics commands](docs/upgrading.md#message-statistics-commands).
To add a command, follow [adding a slash command](docs/contributing/adding-a-command.md).

## Project layout

```text
src/
  core/         contracts, errors, Result, i18n, IoC, logging, policies
  persistence/  repository contracts and Mongoose storage
  infra/        Discord, MongoDB, HTTP and provider adapters
  application/  feature services shared by handlers and plugins
  handlers/     commands, buttons, modals, select menus
  plugins/      features, event subscriptions and scheduled jobs
  bot/          composition roots (one directory per bot) and lifecycle
  i18n/         en and zh-TW translation catalogs
scripts/        runtime launcher, environment setup, deployment, codegen
tools/          operator CLIs: db maintenance, host migration, archive benchmarks
test/           unit, integration, contract and i18n suites
```

Lower layers never import higher ones, and handlers and plugins do not import each
other; ESLint enforces the boundaries.
[Architecture](docs/architecture.md) explains the layers, startup, plugins and
dependency injection, the request flow and message archive ownership.

## Documentation

The [documentation index](docs/README.md) lists the guides under `docs/`.

| Task                                       | Guide                                                   |
| ------------------------------------------ | ------------------------------------------------------- |
| Install and run locally                    | [Local setup](docs/contributing/local-setup.md)         |
| Configure a bot                            | [Configuration](docs/configuration.md)                  |
| Understand the system                      | [Architecture](docs/architecture.md)                    |
| Operate the message archive and `/traffic` | [Message archive](docs/message-archive.md)              |
| Moderate threads                           | [Thread moderation](docs/thread-moderation.md)          |
| Deploy or update systemd services          | [Deployment](docs/contributing/deployment.md)           |
| Diagnose database or connectivity problems | [Operations](docs/contributing/operations.md)           |
| Upgrade an existing installation           | [Upgrade notes](docs/upgrading.md)                      |
| Move to another host                       | [Migration runbook](tools/migration/README.md)          |
| Measure archive performance                | [Archive benchmarks](tools/archive-benchmark/README.md) |
| Add a command, plugin or persisted model   | [Contributing](CONTRIBUTING.md)                         |
| Review releases                            | [Changelog](CHANGELOG.md)                               |

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) owns the [quality gates](CONTRIBUTING.md#quality-gates)
that must pass before every commit and the
[architectural rules](CONTRIBUTING.md#architectural-rules). Security issues are
reported as described in
[reporting a security vulnerability](CONTRIBUTING.md#reporting-a-security-vulnerability).

## License

[MIT](LICENSE).
