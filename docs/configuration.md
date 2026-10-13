# Configuration

Nijika enables `thread_moderation: { "enabled": true }` and the `thread` command group.
Management requests go by DM to all configured `admin` IDs; no review-channel setting is needed.
Omission disables the feature; invalid blocks and enabled
moderation without `MONGO_URI` fail startup. See [thread moderation](thread-moderation.md)
for authority, required Discord permissions, persistence and failure behavior.

Each bot reads secrets from `src/bot/<name>/.env` and settings from `config.json`.
Copy its `config.example.json`, replace placeholders, and keep both local files
out of Git. Use JSON **strings** for Discord IDs.

See [local setup](contributing/local-setup.md) and
[deployment](contributing/deployment.md) for runtime and service settings.

## Environment variables

[env.ts](../src/core/config/env.ts) defines validation. Invalid values and token
placeholders fail startup; there is no root `.env.example`.

| Key                                                                    | Requirement / default                                           |
| ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| `TOKEN`, `CLIENT_ID`                                                   | Required Discord token and application ID                       |
| `MONGO_URI`                                                            | Required for database-backed bots; optional for gopher          |
| `PORT`                                                                 | Required by nijika's webhook and gopher's settings API          |
| `MONGO_RECOVERY_INTERVAL_MS`                                           | Recovery polling, default `60000`                               |
| `NODE_ENV`                                                             | `development` (default), `test`, or `production`                |
| `LOG_LEVEL`                                                            | `trace`, `debug`, `info` (default), `warn`, `error`, or `fatal` |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY` | Keys for enabled providers; blank means absent                  |
| `ACCUWEATHER_KEY`                                                      | Required for weather commands                                   |
| `GOPHER_SETTINGS_API_KEY`                                              | Required when gopher's settings API is enabled                  |
| `BOTFLEET_READY_FILE`                                                  | Deployment-managed startup marker; omit for manual startup      |

## Common bot settings

The optional base fields are defined by [Config](../src/bot/index.ts).

| Field                         | Purpose                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `admin`                       | Bot-admin IDs for `/ai whitelist`, `/bug_report`, msg-archive's `/archive` and its notices; default `[]`    |
| `language`                    | `zh-TW` (default) or `en`; also controls registered command text                                            |
| `commands`                    | Commands to expose; [register again](contributing/local-setup.md#registering-slash-commands) after changing |
| `guilds.<id>.channels`        | Symbolic channel names mapped to IDs                                                                        |
| `guilds.<id>.roles`           | Symbolic role names mapped to IDs                                                                           |
| `guilds.<id>.permission_rank` | Channel privacy and member clearance, below                                                                 |

Missing channel mappings skip channel-bound output. Message backups still run
without a `debug` channel.

## Feature settings

Use the matching example:
[nijika](../src/bot/nijika/config.example.json),
[tomori](../src/bot/tomori/config.example.json),
[konata](../src/bot/konata/config.example.json),
[gopher](../src/bot/gopher/config.example.json), or
[msg-archive](../src/bot/msg-archive/config.example.json).
Plugin settings are validated at startup; strict schemas reject unknown keys.

| Setting                         | Bot            | Purpose / default                                                                  |
| ------------------------------- | -------------- | ---------------------------------------------------------------------------------- |
| `llm_auto_reply`                | gopher         | Self-hosted endpoint, reply probability, context, cooldown and timeout             |
| `settings_api`                  | gopher         | Disabled; binds `127.0.0.1` at `/settings`, using `PORT` and bearer authentication |
| `identity_sync`                 | gopher         | Avatar/nickname sync; requires `sourceUserId` when sync is enabled                 |
| `social_link_preview`           | nijika, tomori | Disabled; provider/proxy lists and request limits                                  |
| `social_feed`                   | nijika         | Disabled; enabled feeds require a nonempty `platforms` map (`x` supported)         |
| `guild_events.attachment_cache` | nijika, tomori | Enabled; see attachment storage below                                              |
| `level_roles`                   | nijika         | `level_<n>` to role-name map for `/update_role`                                    |
| `auto_reply`                    | nijika, tomori | Per-user `luckyReplies`; `globalLuckyProbability` defaults to `0.005`              |
| `weather_forecast.locationKey`  | nijika, tomori | AccuWeather location ID                                                            |
| `random_restaurant.apiUrl`      | nijika, tomori | Absolute HTTP(S) recommendation endpoint                                           |

Invalid role, weather or restaurant settings disable the affected command.

### Social previews and feeds

Enabled previews require all six proxy-host lists: `twitterProxyHosts`,
`instagramProxyHosts`, `threadsProxyHosts`, `facebookProxyHosts`,
`redditProxyHosts` and `bilibiliProxyHosts`. Hosts are tried in order; maintain
short lists of working hosts.

`social_link_preview.allowedBotIds` is an array of Discord bot user ID strings,
defaulting to `[]`. Add a source bot's user ID to let its links trigger previews;
for example, put gopher's user ID in nijika's allow list to preview gopher's links.
Other bot messages are ignored, and the preview bot always ignores its own messages,
even if its ID is listed. Allowed bot messages still require enabled previews and
must pass the existing guild, channel privacy and Discord permission checks.

`/feed subscribe`, `/feed unsubscribe` and `/feed list` manage database-backed
subscriptions in visible channels. Subscribe requires a media filter; repeating
it replaces the filter, and omitting a keyword clears the old value. New
subscriptions forward original posts from creation time, without backfill.
`maxPostsPerPoll` defaults to `5` per subscription (maximum `20`); polling defaults
to `300000` ms with a full sweep every `12` polls.
See [feed migration](upgrading.md#migrating-from-x_media_feed-to-social_feed).

### Giveaway destination

`/giveaway create` defaults to `destination: current`. `configured` uses
`guilds.<id>.channels.giveaway` and fails if that destination is unavailable.

### Settings API transport

Keep the settings API on loopback or use HTTPS/an encrypted tunnel. Bearer
authentication does not encrypt traffic; rotate keys exposed over plain HTTP.

## Channel privacy

`guilds.<id>.permission_rank` accepts three maps:

- `channels`: channel ID to rank; unlisted channels default to `0`.
- `roles`: role ID to clearance; a member receives their highest role clearance.
- `features`: feature to `{ maxChannelRank }`; `null` means unbounded. Defaults:
  `guild_events: 0`, `channel_logging: 0`, `social_preview: null`.

Ranks must be non-negative. Effective channel rank includes its full ancestry;
features suppress output above their ceiling. Invalid settings fail startup.
These ranks supplement Discord permissions. Host logs and deleted-attachment
archives can still contain private-channel data; restrict filesystem access.
See [data-command privacy](architecture.md#privacy-aware-data-commands).

## Attachment storage

Guild-events caches non-bot attachments in `data/attachment_cache/` for 24 hours
and moves deleted files to `data/deleted_attachments/<guildId>/`. Cache retention
does not expire the deleted-file archive. Disabling
`guild_events.attachment_cache.enabled` attempts downloads only on deletion,
when the source may already be unavailable.

There is no total-size cap; each file is limited to 100 MB. New cache writes pause
below `minFreeDiskMb` (default `5120`), but archiving cached files and delete-time
downloads continue. Allow extra headroom for in-flight downloads.

## Message archive

`backup_server` selects msg-archive's guilds. Periodic history backup defaults to
disabled per guild; live capture and full backups remain active. Add `"archive"`
to `commands` and register msg-archive's commands to use `/archive`. Only users in
msg-archive's `admin` list may use it; server owners and Manage Server holders need
to be listed too. Configure `guilds.<guildId>.channels.debug`: every archive command
and button requires that channel, with the bot able to view it, send messages and
embed links. See [access and confirmations](message-archive.md#access-and-confirmations).
The [full backup](message-archive.md#full-backup) and periodic failure notices use
these same settings.
`backup_interval_minutes` supplies the initial interval (default `60`); persisted
slash-command settings override it. `/archive schedule enabled:true minutes:<value>`
saves an interval and enables scanning together; omitting `minutes` keeps the saved
value.
`backup_log_enabled` defaults to `false` and
enables transcripts under `logs/backup/`. See [schedule controls](message-archive.md#periodic-schedule).

### Archive policy

`archive_policy` decides which bot and webhook messages msg-archive keeps. It
defaults to `{ "version": "1", "bots": [], "webhooks": [] }`. Its guild scope is
`backup_server`; a rule's `guildIds` only narrows that rule further.

- Human messages are always kept.
- A live update that does not name its author (a partial Gateway event for a
  message the archive does not hold yet) keeps only the message's identity, and its
  content never enters the inbox. The REST read that follows classifies the author;
  if the policy then rejects the message, the identity-only document is removed.
- A bot or webhook message is kept in full only when a rule with `action:
"include"` (the default) matches it. Rules are evaluated in order within each
  source class (`bots` by the bot's user ID, `webhooks` by the webhook ID); the
  first matching rule decides, and a matching `exclude` rule drops the message.
- A bot's reply to an interaction (a slash or context command, button, select menu
  or modal) that no rule matches keeps only its interaction record: message and
  channel IDs, author, application ID, `interactionMetadata` (including the user
  who invoked the interaction), message type and times. Content, attachments, embeds, reactions and edit history are not kept;
  `excludedFields` lists the omitted fields and `policy.reason` is
  `interaction-record`. `/traffic apps` counts command use from these records; a
  command answered only ephemerally leaves no record.
- An interaction reply sent through the application's webhook is also matched
  against the `bots` rules for its author, so an `exclude` rule for a bot drops even
  its interaction records, and an `include` rule keeps its replies in full.
- Other bot and webhook messages are not kept.

Policy changes apply to new observations only. Adding an `exclude` rule, or
removing an `include` rule, does not delete or shrink messages already stored;
remove them manually if they must go (with msg-archive stopped, from the guild's
`messages` collection, matching `policy.ruleId` or `author.id`).

Each rule needs a unique `ruleId` and numeric-string `sourceId`. Optional
conditions are `guildIds`, `channelIds` (also matching thread parents),
`parentIds`, `applicationIds`, `messageTypes`, literal `contains`, and `structures`
(`attachments`, `embeds`, `stickers`, `poll`, `components`, or `snapshots` for
forwarded messages). The parent of a channel comes from the Gateway event, the
client cache or `archive_channels`. Changing `version` marks a policy change; kept
bot and webhook messages record the version in `policy.version`. Use source IDs,
never tokens or webhook URLs. See the [policy schema](../src/core/archive/policy.ts)
for accepted structures and limits.

### Archive runtime

`archive_runtime` is optional:

| Field                            | Default         | Purpose                                                         |
| -------------------------------- | --------------- | --------------------------------------------------------------- |
| `concurrency`                    | `2`             | Background readers, range 1–32                                  |
| `progress_interval_seconds`      | `10`            | Fixed ten-second full-backup panel cadence; only `10` accepted  |
| `overlap_minutes`                | `60`            | Incremental overlap before watermarks and Gateway downtime      |
| `job_poll_seconds`               | `5`             | Full-backup job polling and the idle inbox loop's recheck       |
| `max_pending_events`             | `1000`          | In-process admission limit; ×10 sizes the changed-message table |
| `max_inbox_bytes`                | `1000000000`    | Durable inbox allocation limit                                  |
| `storage.budget_bytes`           | `100000000000`  | Entire BotFleet budget                                          |
| `storage.background_limit_bytes` | `85000000000`   | Background work ceiling                                         |
| `storage.reserve_bytes`          | `5000000000`    | Budget/filesystem headroom                                      |
| `storage.mongo_data_root`        | auto-discovered | Explicit MongoDB data root if discovery is unavailable          |
| `storage.additional_roots`       | `[]`            | Other managed storage roots, re-measured every ten minutes      |

The [runtime schema](../src/plugins/message-backup/config.ts) defines validation
limits. Storage roots must be accessible on the worker host. Capacity includes
projected writes; lowering a budget never authorizes deletion. The MongoDB data
root is measured on every sample; the project, the runtime and `additional_roots`
are re-measured every ten minutes (see [capacity](message-archive.md#status-panel)).
The worker saves its latest host measurement for `/archive status`.

Concurrency and notification cadence share validators across startup, scheduling,
notifications and deploy preparation. Concurrency does not bound memory or Discord
load: the staging budget below caps in-flight reads and staged pages at any setting,
and the shared SDK REST manager paces every request under Discord's limits. Queued
reads and byte reservations are bounded at 16 per reader (at least 128), the same
headroom the previous maximum of 8 had. Before raising it, check the
[performance log](message-archive.md#backup-throughput) for which
limit is waiting. Internal batches normally stop at 500 documents
or 4 MiB. A single larger message image uses its own batch up to the existing
15 MiB safety limit; it is never truncated. History/reaction staging shares a 128 MiB owner budget. These bounds are
implementation limits, not additional configuration fields. CPU worker offloading
remains disabled; see the [measurement report](contributing/archive-performance-results.md).

### Grouped command configuration

Enable related actions with a single root ID in `commands`: `feed`, `reply`,
`activity`, `giveaway`, `ai`, `thread`, or `traffic`. Do not list subcommand paths
or retired standalone IDs. Enabling a root exposes all its subcommands, with
unchanged per-action permission checks. See the [migration table](upgrading.md#grouped-slash-commands)
for the exact old-to-new mapping and command registration steps.
