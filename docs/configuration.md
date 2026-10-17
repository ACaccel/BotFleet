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

| Key                                                                    | Requirement / default                                                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `TOKEN`, `CLIENT_ID`                                                   | Required Discord token and application ID                                                               |
| `MONGO_URI`                                                            | Required for database-backed bots; optional for gopher                                                  |
| `MONGO_RECOVERY_INTERVAL_MS`                                           | Recovery polling, default `60000`                                                                       |
| `NODE_ENV`                                                             | `development` (default), `test`, or `production`                                                        |
| `LOG_LEVEL`                                                            | `trace`, `debug`, `info` (default), `warn`, `error`, or `fatal`                                         |
| `LOG_DIR`                                                              | File log root, default `logs`; empty disables file logs                                                 |
| `LOG_RETENTION_DAYS`                                                   | Days of file logs to keep, default `60`; `0` keeps all                                                  |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY` | Keys for enabled providers; blank means absent                                                          |
| `CWA_API_KEY`                                                          | Optional Nijika/Tomori key for [earthquake reports](#earthquake-alerts-and-reports); blank means absent |
| `EARTHQUAKE_ALERT_PORT`                                                | Optional Nijika/Tomori [earthquake alert](#early-warning-api) port (1–65535); blank means absent        |
| `EARTHQUAKE_ALERT_KEY`                                                 | Alert bearer secret, at least 32 characters; required when `EARTHQUAKE_ALERT_PORT` is set               |
| `MONGO_INSPECT_URI`                                                    | Read-only account for nijika's [`/db`](#database-inspection); required once `db` is enabled             |
| `NOTIFY_API_PORT`                                                      | Optional konata [notification relay](#notification-relay-api) port (1–65535); blank means absent        |
| `NOTIFY_API_KEY`                                                       | Relay bearer secret, at least 32 characters; required when `NOTIFY_API_PORT` is set                     |
| `PLEIADES_READY_FILE`                                                  | Deployment-managed startup marker; omit for manual startup                                              |

### Log retention

Each bot process prunes `LOG_DIR` at startup and then about every 24 hours. It
deletes regular files named `YYYY-MM-DD.log` (bot and guild logs) or
`*-YYYY-MM-DD_HH-MM-SS.log` (msg-archive transcripts) dated more than
`LOG_RETENTION_DAYS` local days ago, then removes directories left empty.

- Age comes from the file name, never from modification time. Other names and
  symlinks are left alone.
- msg-archive transcripts live in `logs/backup/` of the working directory, so they
  are pruned only while `LOG_DIR` is the default `logs`.
- A non-numeric, negative, fractional or blank value fails startup; the maximum is
  `3650`. Pruning failures are written to stderr and never stop the bot.

## Common bot settings

The optional base fields are defined by [Config](../src/bot/index.ts).

| Field                         | Purpose                                                                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin`                       | Bot-admin IDs for `/ai whitelist`, anonymous `/talk`, closing `/bug_report` tickets, nijika's `/db`, msg-archive's `/archive` and notices; default `[]`     |
| `language`                    | `zh-TW` (default) or `en`; also controls registered command text                                                                                            |
| `timeZone`                    | IANA zone for report calendars, such as `/traffic` days and heat maps; default `UTC`; an unknown zone stops startup                                         |
| `commands`                    | Commands to expose; an unknown name stops startup and registration; [register again](contributing/local-setup.md#registering-slash-commands) after changing |
| `guilds.<id>.channels`        | Symbolic channel names mapped to IDs                                                                                                                        |
| `guilds.<id>.roles`           | Symbolic role names mapped to IDs                                                                                                                           |
| `guilds.<id>.permission_rank` | Channel privacy and member clearance, below                                                                                                                 |

Features look up these symbolic names:

| Name         | Kind    | Used by                                                      |
| ------------ | ------- | ------------------------------------------------------------ |
| `debug`      | channel | Command logs, archive panels and operator notices            |
| `event`      | channel | Guild-event mirror (message edits, deletions, member events) |
| `giveaway`   | channel | `/giveaway create destination:configured`                    |
| `earthquake` | channel | Earthquake early warnings and CWA reports                    |
| `ban_user`   | role    | Pinged by `/ban_user` vote calls; none when unset            |
| `earthquake` | role    | Pinged by early warnings at the configured local intensity   |

Missing channel mappings skip channel-bound output. Message backups still run
without a `debug` channel.

Command logs in `guilds.<id>.channels.debug` use blue-purple embeds: the title
shows the full slash-command path (including subcommand groups), or the context-menu
command name; inline fields show user and channel mentions, and the footer shows
the interaction's creation time in Discord's local time format. Labels follow the
bot's `language`; argument values are omitted. The bot needs **Embed Links**
permission in the debug channel. The `channel_logging` permission-rank ceiling
still suppresses these embeds; durable guild audit logs remain unchanged.

## Tomori and Nijika server panel

Tomori and Nijika automatically expose [`/settings`](tomori-settings.md). Guild preferences
are persisted separately from deployment configuration. `guild_settings` accepts
operator-only `maxRandomProbability` (0-1, default `1`) and
`minCooldownSeconds` (integer 0-86400, default `0`); unknown keys fail startup.
The former caps the saved random-reply probability; the latter is a minimum
cooldown, so increasing it restricts message frequency. Social capability,
providers and URL-count ceilings come from `social_link_preview`.
Per-server public language/time zone inherit `language`/`timeZone` until changed
in the panel. Entertainment cooldowns and moderation-vote parameters live only in
the per-guild database; see [editable preferences](tomori-settings.md).

Automatic replies support keyword matching, random `[*]` replies, dice and special
reactions. Per-user targeted replies are retired; remove `auto_reply.luckyReplies`
from existing deployment configuration. See the panel guide for seeding, permission
policy, safe new-guild defaults, storage boundaries and the application control database.

## Feature settings

Use the matching example:
[nijika](../src/bot/nijika/config.example.json),
[tomori](../src/bot/tomori/config.example.json),
[konata](../src/bot/konata/config.example.json),
[gopher](../src/bot/gopher/config.example.json), or
[msg-archive](../src/bot/msg-archive/config.example.json).
Plugin settings are validated at startup; strict schemas reject unknown keys.

| Setting                         | Bot            | Purpose / default                                                                          |
| ------------------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| `llm_auto_reply`                | gopher         | Self-hosted endpoint, reply probability, context, cooldown and timeout                     |
| `identity_sync`                 | gopher         | Avatar/nickname sync; requires `sourceUserId` when sync is enabled                         |
| `social_link_preview`           | nijika, tomori | Disabled; provider/proxy lists and request limits                                          |
| `social_feed`                   | nijika, tomori | Enabled feeds require a nonempty `platforms` map (`x` and `bahamut` supported)             |
| `guild_events.attachment_cache` | nijika, tomori | Enabled; see attachment storage below                                                      |
| `level_roles`                   | nijika         | `level_<n>` to role-ID map for `/role sync`; a non-ID value disables the command           |
| `temp_role.maxActivePerMember`  | nijika, tomori | Active temporary roles per creator in a guild; default `3`, integer `1`–`50`               |
| `bug_report.hub`                | nijika, tomori | Required for `/bug_report`: `guildId` and forum `channelId` receiving every ticket         |
| `bug_report.tags`               | nijika, tomori | Optional forum tag names for `bug`, `suggestion`, `other`, `open`, `in_progress`, `closed` |
| `auto_reply`                    | nijika, tomori | Random `[*]` reply probability; `globalLuckyProbability` defaults to `0.005`               |
| `random_restaurant.apiUrl`      | nijika, tomori | Absolute HTTP(S) recommendation endpoint                                                   |
| `notificationRoutes`            | konata         | Named [notification relay](#notification-relay-api) destinations; default none             |

Invalid role or restaurant settings disable the affected command.

`/bug_report` posts each ticket in the `bug_report.hub` forum, which may sit in a
guild the bot does not otherwise serve. The bot must be a member there with View
Channel, Send Messages, Send Messages in Threads, Embed Links, Manage Threads, Add
Reactions and Read Message History on the forum; the bug-report plugin checks this
at startup and is disabled (failing readiness) when a permission is missing. Tags
named in `bug_report.tags` must already exist on the forum; unknown names are
logged and skipped.

`/change_avatar` reads each persona's image from `data/avatars/<avatar_file>`, with
names from [`identity.json`](../src/handlers/commands/change_avatar/identity.json).
`data/` is shared across releases and kept out of version control, so artwork is
never published with the source; a missing file is reported and nothing changes.

### Roles and posting

Enable the `role` command ID for `/role panel`, `/role sync` and `/role temp
create|list|delete`. Temporary roles are permission-less, mentionable and prefixed
with `🔔 `; creation refuses an existing role name and enforces
`temp_role.maxActivePerMember` (default `3`, range `1`–`50`). Listing replies
privately. A role's creator, a configured bot admin or a member with Manage Roles
may end it early; failed Discord deletion preserves its expiry tracking.

`level_roles` maps `level_<n>` thresholds to role IDs in any order; a role name
or other non-ID value makes the block invalid. `/role sync` reads all MEE6 leaderboard pages,
assigns each member's highest qualifying role and removes other configured level
roles; unmanageable roles are skipped. It reports granted, removed and failed
changes, with a ten-minute cooldown per guild; an unavailable leaderboard resets
the cooldown for a retry.

`/talk` signs messages by default, accepts an optional destination channel and
requires the member to be able to post there. `anonymous:true` requires a bot
admin and records the sender in logs. Messages may ping members and roles;
`@everyone` or `@here` text produces a warning without any pings.

### AI models and usage limits

The `ai` block applies to bots with the LLM chat plugin and `/ai` commands.
Omitting `ai.models` permits every model from the provider catalog. When set,
`ai.models.allowed` maps `xai`, `openai`, `anthropic` or `gemini` to 1–25 model
IDs each; a missing provider is unavailable to members. Model IDs must be 1–100
characters. `ai.models.default` contains `provider` and `model`, and must appear
in the allowlist. Invalid settings fail startup validation.

`/ai settings` offers members only allowed models and rechecks the policy when
its modal is submitted. If a saved choice is no longer allowed, chat uses the
configured default without changing the saved settings; `/ai status` reports
that fallback. Bot admins can choose any catalog model and bypass the model
restriction and usage limits, but still require an AI whitelist entry.

| `ai.rateLimit` field | Default | Valid values     |
| -------------------- | ------- | ---------------- |
| `perUserPerHour`     | `30`    | Positive integer |
| `perUserPerDay`      | `200`   | Positive integer |
| `concurrent`         | `1`     | Integer 1–5      |

When `rateLimit` is supplied, all three fields are required. Hourly and daily
limits count admitted requests in rolling windows per member and guild, including
provider failures. Requests rejected as busy, over quota, empty, or belonging to
another member's session do not consume quota. Usage persists across restarts;
only user IDs and timestamps are stored, with a 25-hour TTL. The plugin serializes
admission within each process; independent bot processes sharing a guild database
can still race at the quota boundary. Busy members receive a retry message;
quota refusals show the earliest retry time.

### Social previews and feeds

Enabled previews require all six proxy-host lists: `twitterProxyHosts`,
`instagramProxyHosts`, `threadsProxyHosts`, `facebookProxyHosts`,
`redditProxyHosts` and `bilibiliProxyHosts`. Hosts are tried in order; maintain
short lists of working hosts. A host whose response is a login wall, an error
page or a redirect back to the source site is skipped; when no host yields a
usable preview, the message gets no reply.

Previews cover post permalinks plus these short and share forms: Instagram
`/share/` links, Threads `/share/` links, Facebook `/share/` links, `fb.watch`,
`/photo/?fbid=` photos and group permalinks, Reddit `redd.it` short links,
`/r/<sub>/s/` share links and `/gallery/` posts, and Bilibili `b23.tv` links.
Links inside `<...>`, a code span or block, or a spoiler (`||...||`) are not
previewed, and full-width punctuation directly after a link ends it.

Threads previews render custom cards from the selected proxy's validated
OpenGraph text and images, linking to the original post. They do not require
Discord to expand the proxy URL again. Image cards use the gallery delivery
described below. A successfully uploaded direct video replaces the preview
images; failed downloads or uploads retain the image card with a fallback link.

Facebook previews use a custom card with a Facebook header, a title linking to
the source post, and available OpenGraph text and images. All distinct HTTPS
images are shown in source order, in galleries of up to four images per reply;
additional galleries use separate replies without repeating the post text.
Linked titles retain up to Discord's 256-character limit and wrap according to
the client's available width; the bot does not impose a one-line cutoff.
The body is capped at 350 Unicode
code points, including the trailing `...` when truncated. Metadata comes from
the configured proxies, with Facebook's own OpenGraph as a fallback. Author
details depend on the source. Facebed's source summary supplies total reactions
(shown with a thumbs-up icon), comments and shares for the card footer. Each
unavailable count is omitted; reported zeroes and compact values such as `1.2K`
are preserved. Counts reflect the upstream response and preview cache rather
than live updates after the message is sent.
If browser redirects cannot expand a share link, the provider also tries the
source-owned permalink from Facebook's OpenGraph before falling back to a card.

With `twitterApiBaseUrls` set, X posts are read from an FxTwitter-compatible
API and shown as a custom card: author, text, quoted post, up to four photos,
reply/repost/like/view counts and post time. Video posts still use a proxy link
when a proxy serves a playable video, so Discord plays it at full quality. When
none does, the bot uploads the largest MP4 encoding estimated to fit
`maxVideoBytes` inside a Components V2 card; failing that, the card shows the
video thumbnail and a link. Posts the API marks possibly sensitive, and every
post while no API answers, use a proxy link as before.

When metadata includes a supported direct video URL, the bot downloads it and
uploads it as a Discord attachment. Video downloads accept only HTTPS URLs
with `video/mp4` or `video/quicktime` content types, validate DNS and redirects
against private-network access, and allow at most two concurrent downloads.
Successfully uploaded videos appear last in a single Components V2 card, below
the author, post text, engagement counts and source information. This ordering
also applies to uploaded X videos and social-feed deliveries. Proxy-link previews
are expanded by Discord, which controls their layout.

| `social_link_preview` field | Default           | Allowed values                                | Purpose                                                                 |
| --------------------------- | ----------------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| `maxVideoBytes`             | `8388608` (8 MiB) | Positive integer, at most `26214400` (25 MiB) | Maximum downloaded video size; Discord may enforce a lower upload limit |
| `videoTimeoutMs`            | `15000`           | Positive integer, at most `60000`             | Total video download deadline in milliseconds                           |
| `twitterApiBaseUrls`        | Unset             | Non-empty list of HTTPS URLs                  | FxTwitter-compatible APIs for custom X cards, tried in order            |

Missing direct video metadata, unsupported media, oversized files, download
failures and rejected attachments fall back to the custom card and a clickable
link with automatic embedding suppressed. Static cards retain their preview
image. No Facebook or Threads login or additional scraper service is required; previews
depend on publicly available metadata and media URLs.

#### nhentai and wnacg readers

nhentai gallery links (`nhentai.net/g/<id>/`, optionally `/<page>/`) and wnacg
album links (`photos-index`, `-slist`, `-gallery` or `-slide` pages on any
`wnacg.com` or `wnacg.org` host) become a paged reader, but only in
age-restricted channels; a thread follows its parent. Elsewhere the link is
ignored without contacting the site. The reader is one public message: the
first page lists tags, page count and favourites, and any member can turn
pages with first, previous, next and last buttons, or jump through the form
behind the `page / total` button. Presses on one message are applied in order.

The bot downloads each page and uploads it to Discord itself, so Discord never
contacts the source. After every page shown it downloads the next
`prefetchPages` pages and the previous one in the background. Gallery metadata
is cached for 30 minutes, pages for 30 minutes within `cacheMaxBytes`; both are
lost on restart. Image hosts named by the sites pass the same HTTPS, DNS and
redirect screening as video downloads, and at most four downloads run at once.

With `stagingChannelId` set, prefetched pages (up to twice `prefetchPages`
ahead) are also uploaded to that channel, the next page alone and the rest a
few per message, and requested once through Discord's media proxy. A turn to a
staged page then only changes the embed's image URL; other pages are attached
to the edit. In a measurement on the deployment host, a URL turn took about
0.3–0.5 seconds against 1–1.9 seconds for an attached one. Turns made within a
few seconds of the preview appearing may still attach.

The staging channel must be age-restricted and let the bot view it, send
messages, attach files and read history; Manage Messages enables bulk cleanup.
Otherwise staging stays off, a warning is logged, and the channel is checked
again after ten minutes. Each bot deletes its own staging messages after 24
hours, hourly and at startup, so several bots can share one channel. A reader
left idle for a day can lose its image when its page is deleted or its signed
URL expires; any button restores it. Server administrators can see the
channel, since Discord cannot hide a channel from them.

Both sources are provider names, so `providers` and the `/settings` provider
subset control them. They start enabled on every server: new servers get them
by default, and settings schema version 3 adds them once to servers saved
earlier. A manager who removes them keeps them removed. The social-preview
feature switch still applies, and a `providers` list in `config.json` must name
them explicitly.

| `social_link_preview.gallery` field | Default             | Allowed values                                       | Purpose                                                   |
| ----------------------------------- | ------------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| `prefetchPages`                     | `5`                 | Integer `0` to `10`                                  | Pages after the one shown to download ahead               |
| `cacheMaxBytes`                     | `67108864` (64 MiB) | Positive integer, at most 512 MiB, ≥ `maxImageBytes` | In-memory page cache budget                               |
| `maxImageBytes`                     | `8388608` (8 MiB)   | Positive integer, at most `10485760` (10 MiB)        | Largest page accepted; stays under Discord's upload limit |
| `imageTimeoutMs`                    | `15000`             | Positive integer, at most `60000`                    | Deadline for one page download                            |
| `stagingChannelId`                  | `null`              | Discord channel ID or `null`                         | Age-restricted channel for pages uploaded ahead of turns  |

`social_link_preview.allowedBotIds` is an array of Discord bot user ID strings,
defaulting to `[]`. Add a source bot's user ID to let its links trigger previews;
for example, put gopher's user ID in nijika's allow list to preview gopher's links.
Other bot messages are ignored, and the preview bot always ignores its own messages,
even if its ID is listed. Allowed bot messages still require enabled previews and
must pass the existing guild, channel privacy and Discord permission checks.

`/feed subscribe`, `/feed unsubscribe` and `/feed list` manage database-backed
subscriptions in visible channels. Use `target` for an X handle or a Bahamut
forum URL. Subscribe requires `target`; unsubscribe can omit it to remove a
platform's subscriptions or request confirmation to clear the channel.
Media is optional: X and Bahamut default to `any`, including text-only posts. Repeating a
subscription replaces its filters; omitting a keyword clears the old value.
New subscriptions start at the current source head without replaying old posts.
`maxPostsPerPoll` defaults to `5` per subscription (maximum `20`); polling defaults
to `300000` ms with a full sweep every `12` polls.

X subscriptions use the same hybrid provider and card renderer as shared-link
previews: text and photo posts become custom cards, playable videos use a proxy,
and sensitive posts or failed status API reads use the proxy. When a video proxy
cannot play the post, the bot tries a bounded video upload (8 MiB, 15 seconds),
then falls back to a thumbnail and source link. The localized announcement and
preview are sent together; video cards include the announcement inside their
Components V2 container.

Feeds use their own `social_feed.platforms.x.apiBaseUrl`, `timeoutMs` and
`embedProxyHost`; they do not depend on `social_link_preview.enabled` or its
provider lists. Status metadata is prepared once per post per account pass and
shared across subscription channels. If no preview is available, delivery
retains the existing proxy-link announcement. Pending matches advance only after
Discord accepts the complete message; send failures retry on the next pass.
Cursor-aware sources also advance past intentionally excluded records after
preceding deliveries succeed, so filtered batches cannot block newer posts.

#### Bahamut subscriptions

Add `"bahamut": {}` to `social_feed.platforms` and enable `social_feed` in the bot's
`config.json`. Restart after changing config. Re-register slash commands when
upgrading to expose the Bahamut choice and `target` option.

| `social_feed.platforms.bahamut` field | Default                      | Constraints                                                                       |
| ------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------- |
| `baseUrl`                             | `https://forum.gamer.com.tw` | HTTP(S) origin or compatible mirror, without credentials, path, query or fragment |
| `timeoutMs`                           | `8000`                       | Integer 1–30000; deadline for each complete source read or floor-link resolution  |
| `maxPages`                            | `5`                          | Integer 1–20; source pages inspected per read, plus thread first-page discovery   |

Two source types are supported:

- **Board:** a `B.php?bsn=...` URL follows newly created topics, not replies that
  bump old topics. A positive `subbsn` restricts the source to that subboard.
  Notifications and filters use the topic title plus its opening floor body and
  media. The adapter explicitly requests creation ordering and verifies it.
- **Thread:** a `C.php?bsn=...&snA=...` URL follows newly published floors by any
  author. Filters use each floor's body and media. Inline comments and edits to
  existing floors do not create notifications.

```text
/feed subscribe platform:bahamut target:https://forum.gamer.com.tw/B.php?bsn=36476
/feed subscribe platform:bahamut target:https://forum.gamer.com.tw/C.php?bsn=36476&snA=3047
```

Official mobile `https://m.gamer.com.tw/forum/B.php` and `C.php` URLs also work.
A desktop `Co.php?bsn=...&sn=...` or mobile `Co.php?bsn=...&snB=...` floor link
resolves to its parent thread; it does not follow only that floor. Resolution
requires a public metadata read. Different URLs for the same board/thread share
one canonical subscription key.

`/feed list` identifies the target type. Boards store `board:36476` (or
`board:36476:3` for a subboard); threads retain `36476/3047`. These keys also work
for subscribe and unsubscribe. Existing thread subscriptions need no database
migration. With `platform:bahamut`, canonical IDs and B/C URLs remain usable for removal
while the platform is disabled; a Co link requires an enabled, reachable resolver. Several
targets can be comma-separated. The former `account` command option has been
removed; use `target` for every platform.

Both platforms' default `media:any` includes text-only posts. Optional `keyword` is one
case-insensitive substring, not a regex or an OR list. It combines with the media
filter using AND. There is no special interpretation of post content.

The adapter reads public HTML without login or paid APIs. Blocked requests or
unrecognized pages produce feed errors and retry on the next poll. Each read
returns at most `maxPostsPerPoll` pending records, oldest first. Filtered records
are checked off; matching records are checked off only after successful delivery.
The list's progress timestamp may therefore refer to a filtered record.
A verified deleted opening floor is checked off without notification, so it cannot
block later topics; an unrecognized missing opening floor remains an error.
If `maxPages` cannot reach the previous cursor, the read fails without skipping
unseen posts. Increase `maxPages` and, if necessary, `timeoutMs` after long downtime;
re-subscribing without first removing the subscription preserves its old cursor.
Cancel and create a new subscription only when intentionally discarding backlog.
Notifications include the source author, canonical post link and a bounded body
excerpt. Private/login-only boards, search results, author feeds and the essence
archive are outside this adapter's scope.

### Giveaway destination

`/giveaway create` defaults to `destination: current`. `configured` uses
`guilds.<id>.channels.giveaway` and fails if that destination is unavailable.

### Earthquake alerts and reports

Nijika and Tomori support two earthquake feeds. Nijika uses each guild's deployment
`earthquake` channel/role. Tomori starts both feeds disabled, including on existing
servers; managers opt in separately in [`/settings`](tomori-settings.md#earthquake-notifications),
choose a shared destination channel and optionally choose an early-warning role.
No role is required to deliver either feed; CWA reports always suppress mentions.

| Message       | Trigger                                                                                             | Mentions                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Early warning | `POST /alerts` from the 地牛Wake Up! caller script ([early-warning API](#early-warning-api))        | The `earthquake` role, when set, from the [ping threshold](#early-warning-api) |
| CWA report    | New Central Weather Administration significant earthquake report (`E-A0015-001`), polled every 60 s | None                                                                           |

Both feeds are optional and independent. Without `EARTHQUAKE_ALERT_PORT` or
`CWA_API_KEY`, the bot logs one startup line and leaves that feed off.
Each process needs its own unused alert port and bearer key; configure the caller
and reverse proxy for the selected bot. The panel cannot create an upstream source.

#### Early-warning API

```text
地牛Wake Up! (Windows) → earthquake-alert.cmd → earthquake-alert.ps1
  → https://<server>.<tailnet>.ts.net/earthquake/alerts  (tailnet-only HTTPS, tailscale serve)
  → http://127.0.0.1:<EARTHQUAKE_ALERT_PORT>/alerts  (nijika or tomori)
```

The API binds `127.0.0.1` only and is reached through `tailscale serve`, which strips
the `/earthquake` mount prefix. Set it up with the
[operator steps](contributing/operations.md#earthquake-alerts); the Windows side is in
[`tools/earthquake-alert/windows`](../tools/earthquake-alert/windows/README.md).

The ping threshold is the optional `earthquake_alert` block of either bot's `config.json`:

```json
"earthquake_alert": { "ping_min_local_intensity": "4" }
```

`ping_min_local_intensity` is a CWA intensity string (`0`–`4`, `5-`, `5+`, `6-`, `6+`,
`7`) and defaults to `4` when the block or field is absent. Any other value or an
unknown key stops startup and deployment preparation. It sets the lowest local
intensity that pings the role, sends the upgrade reply and turns the embed red.

`POST /alerts` with `Authorization: Bearer <EARTHQUAKE_ALERT_KEY>` and a JSON body of at
most 4 KB. Unknown fields are rejected.

| Field              | Type                                                       | Range                   |
| ------------------ | ---------------------------------------------------------- | ----------------------- |
| `epicenterLat`     | number                                                     | −90 to 90               |
| `epicenterLon`     | number                                                     | −180 to 180             |
| `depthKm`          | number                                                     | 0 to 1000               |
| `magnitude`        | number                                                     | 0 to 10                 |
| `maxIntensity`     | CWA intensity string: `0`–`4`, `5-`, `5+`, `6-`, `6+`, `7` | —                       |
| `localIntensity`   | CWA intensity string, as above                             | —                       |
| `arrivalTime`      | integer, local S-wave arrival in Unix seconds              | see test handling below |
| `remainingSeconds` | integer, the app's countdown to that arrival               | −600 to 600             |

`remainingSeconds` may be negative: in the blind zone, or for an update issued after
the S-wave arrived, the countdown has already run out. It is only logged; the message
counts down from `arrivalTime`.

- **Test and replay.** The app's test button sends fixed example values with the
  arrival time stamped from the current clock. A body matching all of those values
  (`APP_TEST_ALERT` in [`alert-request.ts`](../src/plugins/earthquake/internal/alert-request.ts))
  posts nothing and answers `200 {"result": "test"}`, so the button checks the whole
  path without posting. An `arrivalTime` more than 10 minutes before the server clock
  is treated the same way, so a captured request cannot be replayed into a post. An
  `arrivalTime` more than 10 minutes ahead answers `400`.
- **Posting.** Every live alert is posted; the app's own threshold decides what is
  sent. The guild's `earthquake` role is pinged only when `localIntensity` is at or
  above the ping threshold (below). Guilds with the channel but no role get the alert
  without a ping.
- **Updates.** An alert within 3 minutes of the open event's latest alert, with an
  epicenter within 100 km (haversine) of that alert's epicenter, updates the event:
  each guild's message is edited, which never pings. When an update is the event's
  first alert at or above the ping threshold, each guild with the role also gets a
  short reply that pings it. A deleted message is posted anew. Alerts are processed one at
  a time; event state is in memory, so after a restart the next alert posts anew.
- **Message.** The content line holds the headline, prefixed by the role mention when
  pinging. The embed shows magnitude, depth, maximum and local intensity (`5-` as
  5弱, 5 Weak), the arrival as a relative and absolute Discord timestamp, and the
  epicenter (`23.85°N, 120.82°E`, linked to a map). It is red at or above the ping
  threshold, amber below, and its footer credits the source and marks edits.
- **Responses.** `200 {"result": "created" | "updated", "pinged", "guilds"}` (`guilds`
  counts guilds whose message was posted or edited); `200 {"result": "test"}`; `400`
  invalid body (with up to five `fields` paths) or arrival out of range; `401` missing
  or wrong token, with `WWW-Authenticate: Bearer`, checked before anything else; `404`
  other paths; `413` body too large; `503` Discord not ready; `500` unexpected failure.
  Each outcome is logged without headers or the key.

#### CWA reports

- Reports need `CWA_API_KEY`. Get a free key by registering at
  [opendata.cwa.gov.tw](https://opendata.cwa.gov.tw) and copying the member
  page's API authorization code (API授權碼).
- The first successful poll after startup only records the newest report, so a
  restart never reposts old reports; later polls post each newer report once,
  oldest first.
- A failed poll (network, rejected key, malformed response) is logged when it
  starts and when it clears, then retried on the next poll. A malformed report is
  skipped and logged.
- The embed shows the report text, origin time, magnitude, depth, epicenter and
  each county's maximum intensity, links the CWA report page, shows the report
  image and credits the CWA. Its color follows the CWA report color.

### Notification relay API

Konata can relay progress notifications from services on the same host, such as
a deployment controller: the first update posts an embed, later updates edit it.
The API is off unless `NOTIFY_API_PORT` is set, binds `127.0.0.1` only, and needs
konata's MongoDB. Enable it with the [operator steps](contributing/operations.md#notification-relay).

Routes map a name to a channel; callers name a route, never a channel:

```json
"notificationRoutes": {
  "card-together-deploy": { "guildId": "123456789012345678", "channelId": "223456789012345678" }
}
```

Route names match `^[a-z0-9][a-z0-9-]{0,63}$`; IDs are snowflake strings. A malformed
block stops startup. Konata needs View Channel, Send Messages and Embed Links in the
channel; a channel outside its route's guild is rejected when used.

`PUT /notifications/<route>/<key>` with `Authorization: Bearer <NOTIFY_API_KEY>` and a
JSON body of at most 16 KB:

| Field         | Type                                                                                                 | Limit      |
| ------------- | ---------------------------------------------------------------------------------------------------- | ---------- |
| `title`       | string                                                                                               | 1–256      |
| `description` | optional string, shown above the stages                                                              | 3000       |
| `url`         | optional `http(s)` URL linked from the title                                                         | 500        |
| `stages`      | list of `label` (1–100 characters) and `state` (`pending`, `running`, `done`, `failed` or `skipped`) | 0–10 items |
| `status`      | `running`, `succeeded`, `failed` or `cancelled`                                                      | —          |
| `summary`     | optional outcome line                                                                                | 500        |

- `<key>` (`^[A-Za-z0-9._-]{1,100}$`) names one notification thread. The first PUT
  for a route and key posts a message; later PUTs edit it, also after a restart. A
  deleted message is posted anew. Concurrent PUTs for one thread run in order.
- Unknown body fields are rejected. Caller text is shown verbatim and pings nobody.
  Stages are marked ○ pending, ● running, ✓ done, ✗ failed, – skipped; the status
  sets the embed color and a localized label.
- Responses: `200 {"messageId", "created"}`; `400` invalid key or body; `401` missing
  or wrong token, checked before anything but the route name's syntax; `404` unknown
  route; `413` body too large; `503` Discord not ready or database unavailable;
  `502` Discord rejected the request; `500` misconfigured route. Error bodies are
  `{"error": "<reason>"}`; an invalid body also lists up to five `fields` paths.
- Each thread's message ID is kept in the route guild's database for 30 days after
  its last update.

### Gopher LLM endpoint

To change the self-hosted LLM URL, edit `llm_auto_reply.endpoint` in
`src/bot/gopher/config.json`, then restart gopher. The URL must be valid;
configuration is validated and read once at startup. Gopher does not expose a
settings HTTP API or rewrite its configuration.

For a local process, stop it and run `npm run gopher` again. For a managed
deployment, restart `pleiades@gopher.service`; its release links to the same
local configuration. See [deployment](contributing/deployment.md).

### Database inspection

Nijika's `/db` gives its `admin` users a read-only, ephemeral view of every guild
database on the server, message content included. It is off by default and
available on nijika only; another bot listing `db` fails startup.

1. Create a MongoDB user limited to `readAnyDatabase`; see
   [deployment](contributing/deployment.md#read-only-inspection-account).
2. Set `MONGO_INSPECT_URI` in `src/bot/nijika/.env` to
   `mongodb://inspector@127.0.0.1:27017/?authSource=admin`, adding the user's
   password after `inspector`, separated by a colon.
3. Add `db` to nijika's `commands` and
   [register commands](contributing/local-setup.md#registering-slash-commands).

Listing `db` without `MONGO_INSPECT_URI` fails startup. An account that is not
authenticated or holds any write action disables the db-inspect plugin, which
withholds readiness; `/db` then answers that it is unavailable. See
[database inspection](architecture.md#database-inspection) for limits and audit logs.

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

Nijika and Tomori guild-events cache non-bot guild-message attachments in
`data/attachment_cache/` for 24 hours
and moves deleted files to
`data/deleted_attachments/<guildId>/<messageId>/<YYYY-MM-DD_HH-MM-SS>_<name>`,
for example `data/deleted_attachments/123/456/2026-10-13_09-05-30_image.png`.
The directory name is the `messageId` in the matching `message_delete` audit line;
the stamp is the deletion time in the host's local timezone. Same-second duplicates
get an ordinal (`..._image-2.png`); files are never overwritten. Cache retention
does not expire the deleted-file archive. Turning off event mirroring in `/settings`
or restricting its permission rank does not stop local attachment storage. This is
independent of msg-archive, which stores attachment metadata rather than files. Disabling
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
| `overlap_minutes`                | `60`            | Incremental overlap before watermarks and Gateway downtime      |
| `job_poll_seconds`               | `5`             | Full-backup job polling and the idle inbox loop's recheck       |
| `max_pending_events`             | `1000`          | In-process admission limit; ×10 sizes the changed-message table |
| `max_inbox_bytes`                | `1000000000`    | Durable inbox allocation limit                                  |
| `storage.budget_bytes`           | `100000000000`  | Entire Pleiades budget                                          |
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
