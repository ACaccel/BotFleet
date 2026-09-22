# BotFleet

A multi-personality Discord bot framework built on TypeScript,
discord.js and MongoDB, with a layered plugin architecture, bilingual
i18n, and strict type safety.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](tsconfig.strict.json)

---

## What this is

`BotFleet` hosts several independent bot personalities on a single
shared core. Each personality is a thin composition root that opts
into the plugins it wants; the core takes care of lifecycle,
dependency injection, per-guild MongoDB connections, internationalised
replies, slash-command codegen, and structured error handling.

Highlights:

- **Layered architecture** with ESLint-enforced dependency direction (`core → persistence/infra → handlers/plugins → bot`).
- **Plugin system** with a four-phase lifecycle (`init`, `start`, `onReady`, `onShutdown`), per-plugin failure isolation, and config parsed by each plugin's own factory.
- **Typed IoC container** (no `reflect-metadata`, no DI framework) reachable from plugins only through a typed barrel.
- **Repository pattern** over Mongoose; tests inject in-memory fakes.
- **Strategy-based LLM provider layer** (OpenAI, Anthropic, Gemini, xAI).
- **Strict TypeScript** across the entire `src/`; CJK literals forbidden in handler / plugin code.
- **Bilingual catalogs** (`en`, `zh-TW`) with a CI parity check.

See [`docs/architecture.md`](docs/architecture.md) for the full
single-page overview.

## Built-in personalities

| Bot           | Yarn script        | Surface                                                      |
| ------------- | ------------------ | ------------------------------------------------------------ |
| `nijika`      | `yarn nijika`      | Web-facing; exposes an Express`/discord/earthquake` webhook  |
| `konata`      | `yarn konata`      | Full interactive feature set                                 |
| `tomori`      | `yarn tomori`      | Full interactive feature set                                 |
| `msg-archive` | `yarn msg-archive` | Worker-style; runs only the message-backup plugin            |
| `gopher`      | `yarn gopher`      | Database-free; self-hosted-LLM auto-reply and a settings API |

## Features

- Slash commands, buttons, modals, select menus, and reaction handlers.
- Multi-provider LLM chat with web-search toggle and per-user session persistence.
- Message backup to MongoDB.
- Giveaways with reaction-driven winner selection. `/giveaway_create` accepts an optional
  `destination`: `current` (default) publishes in the invoking channel; `configured` uses
  `guilds.<id>.channels.giveaway` from the bot's `config.json`. An unavailable configured
  channel returns an error without falling back to the invoking channel.
- Per-member activity tracking.
- Social-media share-link previews (Twitter/X, Instagram, Threads, Facebook, Reddit, Bahamut, Bilibili) with original-embed suppression.
- Subscription-driven social feed: `/feed_subscribe`, `/feed_unsubscribe`, and `/feed_list` forward followed accounts' new posts into a chosen channel, each subscription carrying its own media / keyword filter. `/feed_subscribe` requires an explicit `media` choice. Subscribing and unsubscribing take a comma-separated list of accounts, up to 20 per command, and unsubscribing suggests the accounts the target channel has already subscribed as you type. Unsubscribing without naming a platform or an account clears the whole channel, so it asks for confirmation before deleting anything.
- Earthquake alert broadcast via HTTP webhook.
- Scheduled jobs hosted by plugins.
- Built-in `en` / `zh-TW` locales; per-guild command localisation.

## Quick start

```bash
git clone https://github.com/ACaccel/BotFleet.git
cd BotFleet
yarn install --frozen-lockfile
```

Prerequisites:

- Node.js **>= 22.13** (see [`.nvmrc`](.nvmrc))
- Yarn 1 (classic)
- MongoDB (local or hosted) — only the bots that use persistent state need it

For **each** personality you want to run, create the two configuration
files in its directory:

```bash
cp src/bot/nijika/config.example.json src/bot/nijika/config.json
# then create src/bot/nijika/.env with TOKEN, CLIENT_ID, MONGO_URI, ...
```

Run the bot:

```bash
yarn nijika        # or yarn konata / yarn tomori / yarn msg-archive
```

Deploy / refresh slash commands (run once after editing commands):

```bash
yarn deploy
```

## Configuration

### `.env`

Each personality reads its own `.env` from `src/bot/<name>/.env`. The
authoritative schema lives in [`src/core/config/env.ts`](src/core/config/env.ts).

| Key                          | Required | Notes                                                                                                                                       |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `TOKEN`                      | yes      | Discord bot token                                                                                                                           |
| `CLIENT_ID`                  | yes      | Discord application client id                                                                                                               |
| `MONGO_RECOVERY_INTERVAL_MS` | optional | Transient database recovery interval in milliseconds (default `60000`); see [operations](docs/contributing/operations.md#database-recovery) |
| `MONGO_URI`                  | optional | Required for any personality that uses persistent state                                                                                     |
| `PORT`                       | optional | HTTP port for the earthquake webhook (nijika) / settings API (gopher)                                                                       |
| `NODE_ENV`                   | optional | `development` (default), `test`, `production`                                                                                               |
| `LOG_LEVEL`                  | optional | `trace`, `debug`, `info` (default), `warn`, `error`, `fatal`                                                                                |
| `OPENAI_API_KEY`             | optional | Enables OpenAI provider for the LLM chat plugin                                                                                             |
| `ANTHROPIC_API_KEY`          | optional | Enables Anthropic provider                                                                                                                  |
| `GEMINI_API_KEY`             | optional | Enables Gemini provider                                                                                                                     |
| `XAI_API_KEY`                | optional | Enables xAI provider                                                                                                                        |
| `ACCUWEATHER_KEY`            | optional | Weather command                                                                                                                             |
| `GOPHER_SETTINGS_API_KEY`    | optional | Bearer key for gopher's settings REST API (required when it is enabled)                                                                     |

Secrets must never be committed. The schema rejects obvious
placeholders (`your_token`, `changeme`, etc.) at startup.

There is no root `.env.example`: the env contract is per-personality,
and the zod schema in `src/core/config/env.ts` plus the table above are
the authoritative definition. A template file would be a third copy
free to drift from both.

**Transport security for `GOPHER_SETTINGS_API_KEY`.** Bearer auth
authenticates the caller; it does not encrypt the request. Over plain
HTTP the `Authorization: Bearer <key>` header — and the endpoint being
written — travel in cleartext, so a firewall or source-IP allow-list
limits _who_ can connect but does not stop on-path eavesdropping. The
API binds to `127.0.0.1` by default. If you expose the port (router
port-forward, or `settings_api.host: "0.0.0.0"`), front it with TLS — a
reverse proxy such as Caddy or nginx terminating HTTPS and proxying to
`127.0.0.1:<PORT>` — or reach it through an encrypted tunnel (SSH,
Tailscale/WireGuard) and keep the bind on loopback. Rotate the key if it
may have been sent in cleartext.

### `config.json`

Per-personality static configuration, loaded as a sibling of each
composition root (`src/bot/<name>/config.json`). Every personality ships
a checked-in `config.example.json` — copy it, fill in the real IDs, and
keep your `config.json` out of git (it is `.gitignore`d). The shape is
`Config` in [`src/bot/index.ts`](src/bot/index.ts) plus per-personality
extensions. Snowflake ids exceed JavaScript's safe-integer range, so
every id must be a JSON **string**.

Common fields:

| Field                         | Type                | Required | Notes                                                                                                                                                                         |
| ----------------------------- | ------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin`                       | `string[]`          | no       | User ids with bot-admin privileges. Gates `/ai_whitelist_*`; `/bug_report` DMs every id. Default `[]`.                                                                        |
| `language`                    | `"zh-TW"` \| `"en"` | no       | Default display locale, also used for registered slash-command text. Default `"zh-TW"`; an unsupported value warns and falls back.                                            |
| `commands`                    | `string[]`          | no       | The slash commands this personality registers with Discord. Removing an entry only stops re-registering it — run `yarn deploy -t <name>` to take the command down on Discord. |
| `guilds.<id>.channels`        | `Record<name, id>`  | no       | Symbolic channel names (`"debug"`, `"event"`, …) → Discord ids, so handlers look channels up by name.                                                                         |
| `guilds.<id>.roles`           | `Record<name, id>`  | no       | Symbolic role names → Discord ids.                                                                                                                                            |
| `guilds.<id>.permission_rank` | object              | no       | Privacy / clearance ranks for this guild — see below. Validated at startup; a malformed block fails the boot naming the guild.                                                |

`guilds` and both of its maps are optional. A bot may omit a map, a
guild entry, or the whole block: unresolvable ids are dropped and the
bot keeps every feature while silently skipping channel-bound side
effects (the debug interaction log, the guild-event mirror). `tomori`
runs this way. The exception is `msg-archive`, whose backup pass
requires a `debug` channel and aborts without one.

`permission_rank` carries three optional maps: `channels`
(`channelId -> integer >= 0`, higher = more private; an unlisted channel
is rank 0), `roles` (`roleId -> integer >= 0`, keyed by raw Discord role
id — a member's clearance is the max over their ranked roles), and
`features` (per-feature `maxChannelRank` ceiling). A feature is
suppressed on a channel when the channel's effective rank — the max over
the channel and its full ancestry — exceeds that feature's ceiling;
`null` means unbounded. Defaults: `guild_events` `0`,
`channel_logging` `0`, `social_preview` `null`.

Feature blocks are per-personality and every one is optional. Each is
zod-validated with `.strict()` at startup, so an unknown key fails the
boot, and every scalar has a code default — the block may be partial or
omitted entirely. Note that `guild_events` names two unrelated things:
the top-level block below, and a rank-gated feature key inside each
guild's `permission_rank.features` map.

| Block                     | Loaded by      | Fields (default)                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm_auto_reply`          | gopher         | `enabled` (`false`), `probability` (`0.05`), `messageCount` (`5`), `windowSeconds` (`30`), `cooldownSeconds` (`30`), `endpoint` (placeholder), `timeoutMs` (`10000`)                                                                                                                                                                                                                     |
| `settings_api`            | gopher         | `enabled` (`false`), `host` (`127.0.0.1`), `basePath` (`/settings`). The bearer key comes from `GOPHER_SETTINGS_API_KEY`, never this block; an enabled API with no key refuses to start. The listen port is `PORT`.                                                                                                                                                                      |
| `identity_sync`           | gopher         | `enabled` (`false`), `syncWithSource` (`false`), `sourceUserId` (**required** when `enabled && syncWithSource`), `schedule` (`0 4 * * *`), `syncAvatar` / `syncNickname` (`true`), `fallbackNickname` (empty = leave untouched), `fallbackAvatarPath` (`assets/gopher.png`)                                                                                                              |
| `social_link_preview`     | nijika, tomori | `enabled` (`false`), `originalMessageStrategy` (`suppress`), `providers` (all), `timeoutMs` (`4000`), `maxUrlsPerMessage` (`1`), plus six `*ProxyHosts` lists — see below                                                                                                                                                                                                                |
| `social_feed`             | nijika         | `enabled` (`false`), `pollIntervalMs` (`300000`, floor `60000`, ceiling `2147483647`), `fullSweepEveryPolls` (`12`), `maxPostsPerPoll` (`5`, ceiling `20`, **per subscription**), `platforms.x.apiBaseUrl` (`https://api.fxtwitter.com`), `platforms.x.timeoutMs` (`8000`, ceiling `30000`), `platforms.x.embedProxyHost` (`fxtwitter.com`). Who is followed is **not** here — see below |
| `guild_events`            | nijika, tomori | `attachment_cache.enabled` (`true`), `attachment_cache.ttlHours` (`24`), `attachment_cache.minFreeDiskMb` (`5120`) — the pre-delete attachment cache; see below                                                                                                                                                                                                                          |
| `level_roles`             | nijika         | `level_<n>` → role name for the level-role sync. Required by `/update_role`; a malformed block disables the command with `replies:update_role.no_config`.                                                                                                                                                                                                                                |
| `auto_reply`              | nijika, tomori | `luckyReplies` (`{ userId, probability, reply }[]`, default `[]`) and `globalLuckyProbability` (`0.005`). Each entry fires `reply` verbatim for `userId` at `probability`; the lines are operator data, not catalog copy.                                                                                                                                                                |
| `weather_forecast`        | nijika, tomori | `locationKey` (**required** when `/weather_forecast` is enabled) — the AccuWeather location id, e.g. `315078` for Taipei. The API key stays in `ACCUWEATHER_KEY`.                                                                                                                                                                                                                        |
| `random_restaurant`       | nijika, tomori | `apiUrl` (**required** when `/random_restaurant` is enabled) — absolute `http(s)` URL of the recommendation endpoint.                                                                                                                                                                                                                                                                    |
| `backup_log_enabled`      | msg-archive    | `false` — when `true`, each backup pass also writes a transcript under `logs/backup/`                                                                                                                                                                                                                                                                                                    |
| `backup_interval_minutes` | msg-archive    | `60` — minutes between backup passes                                                                                                                                                                                                                                                                                                                                                     |

Several fields carry a required-when rule worth calling out:

- `weather_forecast.locationKey` and `random_restaurant.apiUrl` — both
  are **required whenever their command appears in `commands`**. There
  is no safe default for "which city" or "which recommendation
  service", so the handler validates its block at startup: a missing or
  malformed one is logged at error level and that single command is not
  registered, leaving the rest of the bot's command set intact. Copy the
  values from `config.example.json`.
- `social_link_preview.*ProxyHosts` — the six per-source embed-proxy
  lists (`twitterProxyHosts`, `instagramProxyHosts`, `threadsProxyHosts`,
  `facebookProxyHosts`, `redditProxyHosts`, `bilibiliProxyHosts`) have
  **no code defaults and are required whenever `enabled` is `true`**.
  They name third-party services whose availability changes faster than
  a release ships, so the operator owns them; enabling the feature
  without one fails the boot with an error naming the missing key. Copy
  the audited values from the personality's `config.example.json` rather
  than inventing hosts. While `enabled` is `false` the lists are
  accepted but unread. Each list is probed in order until a host yields
  a playable video or the list ends, so every dead host ahead of a live
  one costs `timeoutMs` before the preview is posted — keep the lists
  short and put the hosts that answer first. A host that answers by
  redirecting back to the source site (a proxy that could not fetch the
  post) counts as dead: Discord would follow that redirect and show the
  source's login wall, so the bot skips it however the source page looks
  from the bot's own address.
- `social_feed.platforms` — **must not be empty when `enabled` is
  `true`**, or the boot fails: a feed with no platform registered could
  only ever refuse every subscription. The block says which platforms
  this bot recognises and how to reach them; only `x` ships today, and
  omitting a platform is how you turn it off. The list of accounts is
  not configuration at all — it lives in each guild's database and is
  edited with `/feed_subscribe` and `/feed_unsubscribe`, so adding an
  account needs neither a config edit nor a restart.
- `guild_events.attachment_cache` — Discord purges an attachment's CDN
  object nearly synchronously with the message deletion, so downloading
  it at delete time usually fails. With the cache on (the default), the
  bot downloads every non-bot guild attachment when its message is
  posted, into `./data/attachment_cache/`, and archives the local copy
  when the message is deleted. **This means a copy of every recent
  attachment — not only deleted ones — sits on the bot host for
  `ttlHours`** (default `24`, swept hourly); size that against your
  disk and your privacy posture, and set `enabled: false` to go back to
  downloading only on delete. There is no total-size cap; the per-file
  ceiling is 100 MB, a download is abandoned once no bytes arrive for
  30 s or once it runs past 10 minutes in total (each logged as a
  warning naming the reason), and the bot stops writing new cache entries while
  the volume holding the cache tree (`./data/attachment_cache/`) has
  less than `minFreeDiskMb` free (default `5120`, i.e. 5 GiB) — a pause
  logged once and lifted once space returns. The floor is checked per
  message rather than per byte, so leave it comfortably above the
  ~400 MB that can already be downloading when it trips. That floor protects the host, not the archive:
  archiving an attachment that was already cached, and the delete-time
  download fallback, both keep running below it.

### Migrating from `x_media_feed` to `social_feed`

**Breaking.** The X-only media feed became a multi-platform,
subscription-driven feed, and the followed accounts moved out of
`config.json` into each guild's database. A bot whose `config.json`
still declares `x_media_feed` refuses to start, with a message naming
the replacement — the rename is deliberately loud, because a silently
ignored block would leave the feed dark.

1. **Rename the block and move the platform options.** `x_media_feed`
   becomes `social_feed`; `apiBaseUrl`, `timeoutMs` and
   `embedProxyHost` move under `platforms.x`. `enabled`,
   `pollIntervalMs`, `fullSweepEveryPolls` and `maxPostsPerPoll` keep
   their names and their defaults. One meaning changed:
   `maxPostsPerPoll` now caps a pass **per subscription** rather than
   per account, so an account followed from three channels can deliver
   up to that many posts into each of them. Copy the new shape from
   [`src/bot/nijika/config.example.json`](src/bot/nijika/config.example.json).
2. **Keep the old account list.** `accounts` and `defaultChannel` are
   gone. Write down what they held before you edit the file: every
   account has to be re-added by hand.
3. **Drop the `x_feed` symbolic channel** from each guild's `channels`
   map. A subscription now names its Discord channel directly, so the
   symbolic name is unused.
4. **Register the commands.** Add `feed_subscribe`, `feed_unsubscribe`
   and `feed_list` to the personality's `commands` array and run
   `yarn deploy -t nijika`; they do not appear in Discord until then.
5. **Re-add every account** with `/feed_subscribe`, naming the channel
   it should post into. The `account` option takes a comma-separated
   list, so one command per channel is usually enough — up to 20
   accounts at a time, each reported back as added, updated, failed
   with the reason, or not attempted (the batch stops early if the
   source starts refusing). Each subscription starts from the moment it is
   created: nothing published before then is backfilled, and nothing
   already forwarded is repeated.

The old cursors are not migrated: they were keyed by handle alone,
while a subscription now tracks its own position per platform, account,
and channel. The retired `xfeedcursors` collection is left behind in
each guild's database — clear it with `yarn db drop-xfeed`, which counts
only until you set `dry_run: false` (see
[`tools/db/README.md`](tools/db/README.md)).

## Moving to another host

Use the [host migration tool](tools/migration/README.md) to prepare an empty
Linux target, install a conda runtime, and transfer MongoDB data and gitignored
runtime files. Application code comes from Git clone; the runbook covers restore
and rollback.

## Adding a command, button, modal, or plugin

See the step-by-step guides under
[`docs/contributing/`](docs/contributing/) —
[adding a slash command](docs/contributing/adding-a-command.md)
(recipe, the 150-line cap for handler `index.ts`, the i18n discipline)
and [adding a plugin](docs/contributing/adding-a-plugin.md) (the
plugin / IoC contract). The quality gates live in
[`CONTRIBUTING.md`](CONTRIBUTING.md#quality-gates).

## Architecture

```
            bot/         composition roots (one per personality)
              |
              v
   handlers/     plugins/        feature surface
              |
              v
    persistence/   infra/        adapters to external systems
              |
              v
            core/               pure domain — no Discord, no Mongo
```

Read [`docs/architecture.md`](docs/architecture.md) for the layer
breakdown, key abstractions, request flow, and plugin lifecycle.

## Development

Every check that gates a change — type-check, lint, format, codegen
drift, the six test projects, coverage, dead-code, and security — is
listed with what it covers in
[`CONTRIBUTING.md` §Quality gates](CONTRIBUTING.md#quality-gates).

## Contributing

Bug reports, feature suggestions, and pull requests are welcome. Read
[`CONTRIBUTING.md`](CONTRIBUTING.md) first; it carries the quality
gates that must pass before review, the architectural rules a reviewer
will hold you to, how to report a security vulnerability privately, and
links to the per-topic guides (local setup, recipes, branching) under
[`docs/contributing/`](docs/contributing/).

## License

MIT — see [`LICENSE`](LICENSE).
