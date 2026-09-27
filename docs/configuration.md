# Configuration

Each personality reads `src/bot/<name>/.env` for secrets and `config.json` for
settings. Copy its checked-in `config.example.json`, replace IDs and endpoints,
and remove unused placeholders. Both local files must stay out of Git.

See [local setup](contributing/local-setup.md) to run a bot and
[deployment](contributing/deployment.md) for host-level `deployment.json` settings.

## Environment variables

The authoritative schema is [env.ts](../src/core/config/env.ts). Invalid values
and obvious token placeholders fail startup. There is no root `.env.example`.

| Key                                                                    | Requirement / default                                                                                             |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `TOKEN`, `CLIENT_ID`                                                   | Required Discord bot token and application ID                                                                     |
| `MONGO_URI`                                                            | Required for database-backed bots; optional for gopher                                                            |
| `PORT`                                                                 | Required by nijika's webhook and gopher's settings API                                                            |
| `MONGO_RECOVERY_INTERVAL_MS`                                           | Recovery polling interval, default `60000`; see [database recovery](contributing/operations.md#database-recovery) |
| `NODE_ENV`                                                             | `development` (default), `test` or `production`                                                                   |
| `LOG_LEVEL`                                                            | `trace`, `debug`, `info` (default), `warn`, `error` or `fatal`                                                    |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY` | Keys for the LLM providers you use; blank values are treated as absent                                            |
| `ACCUWEATHER_KEY`                                                      | Required for the weather command                                                                                  |
| `GOPHER_SETTINGS_API_KEY`                                              | Required when gopher's settings API is enabled                                                                    |
| `BOTFLEET_READY_FILE`                                                  | Absolute startup-marker path supplied by deployment; omit for manual startup                                      |

## Common bot settings

The base type is [Config](../src/bot/index.ts); each personality extends it.
Discord snowflake IDs must be JSON **strings**, not numbers.

| Field                         | Meaning                                                                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin`                       | Bot-admin user IDs; default `[]`. Controls `/ai_whitelist_*` and receives `/bug_report` DMs                                                    |
| `language`                    | `zh-TW` (default) or `en`; also sets registered command text. Unsupported values warn and fall back                                            |
| `commands`                    | Command names to register. After changing the list, [register again](contributing/local-setup.md#registering-slash-commands) to update Discord |
| `guilds.<id>.channels`        | Symbolic channel names such as `debug`, `event` and `giveaway`, mapped to IDs                                                                  |
| `guilds.<id>.roles`           | Symbolic role names mapped to IDs                                                                                                              |
| `guilds.<id>.permission_rank` | Channel privacy and member clearance; see below                                                                                                |

These fields and the `guilds` block are optional. Missing channel mappings skip
channel-bound side effects such as debug logs and event mirrors. The archive
worker requires a `debug` channel for its backup pass.

## Feature settings

Use the examples for your personality:
[nijika](../src/bot/nijika/config.example.json),
[konata](../src/bot/konata/config.example.json),
[tomori](../src/bot/tomori/config.example.json),
[msg-archive](../src/bot/msg-archive/config.example.json),
[gopher](../src/bot/gopher/config.example.json).
Plugin configuration is validated at startup; strict schemas reject unknown keys.

| Setting                         | Used by        | Purpose and requirements                                                                                                         |
| ------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `llm_auto_reply`                | gopher         | Enable self-hosted replies and set endpoint, probability, context window, cooldown and timeout                                   |
| `settings_api`                  | gopher         | Disabled by default; host `127.0.0.1`, base path `/settings`, port from `PORT`, bearer key from `.env`                           |
| `identity_sync`                 | gopher         | Avatar/nickname sync or fallback identity. `sourceUserId` is required when both `enabled` and `syncWithSource` are true          |
| `social_link_preview`           | nijika, tomori | Disabled by default; provider list, proxy hosts, timeout and URL limit. Enabled previews require all six proxy-host lists        |
| `social_feed`                   | nijika         | Disabled by default; polling and platform settings. Enabled feeds require a nonempty `platforms` map; currently `x` is supported |
| `guild_events.attachment_cache` | nijika, tomori | Enabled by default; `ttlHours: 24`, `minFreeDiskMb: 5120`. See attachment storage below                                          |
| `level_roles`                   | nijika         | `level_<n>` to role-name map required by `/update_role`; invalid settings disable that command                                   |
| `auto_reply`                    | nijika, tomori | Per-user `luckyReplies` and `globalLuckyProbability` (default `0.005`); reply text is operator-owned content                     |
| `weather_forecast.locationKey`  | nijika, tomori | AccuWeather location ID required when the command is selected                                                                    |
| `random_restaurant.apiUrl`      | nijika, tomori | Absolute HTTP(S) recommendation endpoint required when the command is selected                                                   |
| `backup_log_enabled`            | msg-archive    | Default `false`; also write transcripts to `logs/backup/`                                                                        |
| `backup_interval_minutes`       | msg-archive    | Default `60`; interval starts after the previous pass completes                                                                  |

Invalid or missing weather/restaurant settings disable the affected command while
leaving the rest available. The archive worker's first pass runs in the background;
service readiness does not wait for it to finish.

### Social previews and feeds

Previews require `twitterProxyHosts`, `instagramProxyHosts`, `threadsProxyHosts`,
`facebookProxyHosts`, `redditProxyHosts` and `bilibiliProxyHosts` when enabled.
Start from the example configuration, then maintain these third-party hosts as
availability changes. Hosts are tried in order; put responsive hosts first and
keep lists short. Redirects back to the source site are skipped.

Feed configuration controls platforms and polling, while subscriptions live in
each guild's database. `/feed_subscribe`, `/feed_unsubscribe` and `/feed_list`
manage them without a restart:

- Subscribe/unsubscribe accept up to 20 comma-separated accounts. Subscribing
  requires an explicit `media` filter; re-subscribing replaces the filter, and
  omitting `keyword` clears its previous value.
- New subscriptions start from creation time, without historical backfill.
  Only original posts are forwarded, excluding replies and reposts.
- `maxPostsPerPoll` is a **per-subscription** cap (default `5`, maximum `20`).
  Polling defaults to `300000` ms, with a minimum of `60000` and maximum of
  `2147483647`; a full sweep runs every `12` polls.
- Members may manage subscriptions only in channels they can view. Clearing a
  channel without naming a platform or account requires button confirmation.

For older installations, follow the [social-feed migration](upgrading.md#migrating-from-x_media_feed-to-social_feed).

### Giveaway destination

`/giveaway_create` defaults to `destination: current`. Choosing `configured`
uses `guilds.<id>.channels.giveaway`; an unavailable configured channel returns
an error rather than posting elsewhere.

### Settings API transport

Keep gopher's settings API on loopback, or expose it through HTTPS or an encrypted
tunnel. Bearer authentication does not encrypt the key or request. Rotate the key
if it may have been sent over unencrypted HTTP.

## Channel privacy

`guilds.<id>.permission_rank` has three optional maps:

- `channels`: channel ID to non-negative rank; unlisted channels have rank `0`.
- `roles`: raw role ID to non-negative clearance; a member gets the maximum of their roles.
- `features`: feature name to `{ maxChannelRank }`; `null` means unbounded.
  Defaults are `guild_events: 0`, `channel_logging: 0`, `social_preview: null`.

A channel's effective rank is the maximum over itself and its full ancestry.
Features suppress Discord output above their ceiling. Invalid rank settings fail
startup. These ranks supplement Discord permissions; they do not replace them.
The top-level `guild_events` settings block is separate from the feature ceiling.

**Host access remains privileged.** Rank gates suppress event mirrors in Discord,
but local event logs and deleted-attachment archives still include private-channel
data. Treat host filesystem access as full channel access. See the
[privacy rules for data commands](architecture.md#privacy-aware-data-commands).

## Attachment storage

The guild-events plugin caches every recent non-bot guild attachment, including
attachments that are never deleted, in `data/attachment_cache/`. On deletion,
it archives the local copy under `data/deleted_attachments/<guildId>/` because
Discord's original CDN copy may already be gone.

- Cache retention defaults to 24 hours, swept hourly; this is not archive retention.
- Set `guild_events.attachment_cache.enabled: false` to download only on deletion,
  accepting that some attachments will no longer be available.
- There is no total-size cap. Files are limited to 100 MB; downloads stop after
  30 seconds without data or 10 minutes total.
- New cache writes pause below `minFreeDiskMb` free space (default 5 GiB). The
  check is per message, so allow headroom for in-flight downloads (about 400 MB).
  Archiving cached files and delete-time downloads continue below that floor.

Size storage for your guilds and restrict access to local logs and archives.
