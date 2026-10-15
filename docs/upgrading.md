# Upgrade notes

## Earthquake early-warning API

Nijika's unauthenticated webhook is retired: `GET /discord/` and
`POST /discord/earthquake` no longer exist, and nijika no longer reads `PORT` or
requires it at startup or deployment preparation. Early warnings now arrive on the
bearer-protected, loopback-only [`POST /alerts`](configuration.md#early-warning-api)
with the alert's values, which nijika renders as an embed.

1. Replace the old caller: whatever called `/discord/earthquake` must be switched to
   the [Windows caller script](../tools/earthquake-alert/windows/README.md); a request
   without the new body and key is rejected.
2. In `src/bot/nijika/.env`, remove `PORT` and add `EARTHQUAKE_ALERT_PORT` and
   `EARTHQUAKE_ALERT_KEY`. A leftover `PORT` is ignored. Without
   `EARTHQUAKE_ALERT_PORT` the API stays off; CWA reports are unaffected.
3. Follow the [operator steps](contributing/operations.md#earthquake-alerts) to expose
   the port through `tailscale serve`, deploy, and test from the warning app.

Alerts now post to every guild with an `earthquake` channel, also without an
`earthquake` role, and ping the role only from local intensity 4; set
[`earthquake_alert.ping_min_local_intensity`](configuration.md#early-warning-api) in
nijika's `config.json` to change that.

## Nijika server settings

Deploy and restart Nijika, then run `npm run register -t nijika` to publish
`/settings`. The command is included automatically even if `commands` omits it.
The first startup seeds existing servers' supported preferences and destinations
once; later joins receive safe defaults. After seeding, edit those preferences in
the panel rather than `config.json`. Tomori's saved settings are unaffected:
records and migration inventories are keyed by application ID.

Before deploying, bind each `auto_reply.luckyReplies[]` entry to its intended
`guildId`; unbound entries no longer send on Nijika. Optional `guild_settings`
operator limits use the same contract as Tomori. Nijika moderation votes now
follow the [panel voter-role policy](tomori-settings.md#moderation-vote-preferences),
including no role ping by default and no message-deletion fallback when a timeout
is refused. Remove the unused `guilds.<id>.roles.ban_user` mapping and use the
moderation form to restrict voters.

Include Nijika's application-ID control database in backups and MongoDB grants.
Social-feed subscriptions, earthquake configuration and level-role sync keep
their existing controls; feed and earthquake background posts still use the
deployment language. See [server settings](tomori-settings.md) for migration,
permissions and recovery details.

## Tomori settings schema version 2

Deploy and restart Tomori, then open a new `/settings` panel. Existing version-1
settings upgrade automatically without replacing saved preferences or history.
The added general settings inherit deployment language/time zone; individual
entertainment commands remain enabled with no cooldown. No command re-registration
is needed for these panel changes if `/settings` is already registered.

Tomori moderation votes now use the panel's voter-role policy rather than
`guilds.<id>.roles.ban_user`, which previously only selected a ping role. The new
role list defaults to empty (all current human members, no ping); managers can
restrict it in the moderation form. Other defaults preserve five votes in sixty
seconds and a one-minute timeout. Tomori requires a moderatable target and does
not replace a refused timeout with message deletion. Other personalities retain
their existing behavior except Nijika, which now shares this panel policy.
See [server preferences](tomori-settings.md) for limits.

## Gopher settings API removal

Gopher no longer exposes the settings HTTP API. Remove `settings_api` from its
`config.json` and `GOPHER_SETTINGS_API_KEY` and `PORT` from its `.env`; these fields
are no longer needed by gopher. Deploy the updated code, then follow
[manual configuration and restart](configuration.md#gopher-llm-endpoint)
for subsequent endpoint changes.

## Command review

Unknown IDs in a bot's `commands` now stop startup and `npm run register`, so remove
retired IDs before deploying. These commands are removed without aliases:

| Removed command       | Alternative                                              |
| --------------------- | -------------------------------------------------------- |
| `/get_avatar`         | The user context menu (Apps → get avatar)                |
| `/change_nickname`    | `/change_avatar`, or the bot's server profile in Discord |
| `/list_guild_members` | Discord's member list                                    |
| `/weather_forecast`   | None                                                     |
| `/search_anime_scene` | None                                                     |
| `/bubble_wrap`        | None                                                     |

1. Remove `get_avatar`, `change_nickname`, `list_guild_members`, `weather_forecast`,
   `search_anime_scene` and `bubble_wrap` from each bot's `commands`. Delete the
   `weather_forecast` block from `config.json` and `ACCUWEATHER_KEY` from `.env`;
   neither is read any more.
2. Deploy, then run `npm run register` (one bot: `npm run register -t <bot>`) so
   Discord drops the removed commands.

Buttons, menus and forms on archive panels from before the `/archive` redesign no
longer answer; run `/archive` again.

Behaviour changes in the remaining commands:

- **`/change_avatar`** is open to every member and reads persona images from
  `data/avatars/` instead of an external host; copy each `avatar_file` named in
  [`identity.json`](../src/handlers/commands/change_avatar/identity.json) there
  before deploying.
- **`/level_detail`** drops `left` and `right`. Without options it shows a paged
  leaderboard embed; `rank` opens the page holding that rank, and `member` shows
  one member's level card.
- **`/giveaway`** limits durations to 1 minute-30 days and draws overdue giveaways
  after a restart instead of discarding them. `/giveaway delete` cancels only your
  own giveaways unless you can manage messages or events, and marks the
  announcement cancelled.
- **`/reply`** records who added each pair. `delete` and `list` answer privately,
  `delete` removes only your own pairs unless you can manage messages, and `list`
  without a keyword lists every keyword.
- **`/traffic user`** answers privately unless `visibility: public` is chosen;
  `top_n` remains only on `emoji` and `sticker`.
- **`/thread claim`** and **`/thread manager`** default `thread` to the current
  thread.
- `/ban_user` and `/roll_call` speak as each bot's persona; Nijika's vote call ends
  with its own line.
- **`/activity`** is rebuilt around buttons: `create` opens a form (optional start
  time, capacity and a `role` limit), members join or withdraw with buttons,
  participants are pinged when sign-ups close and when it starts, and `cancel`
  (organizer or moderators) replaces `delete`. `/activity list` shows open
  activities in channels you can see. Activities posted before this release keep
  working, but their old ✅ reactions are not counted.
- **`/roll_call`** posts a list with a Check in button, takes a `role`, `users` or
  an `activity` (by name, not consumed) and an optional `deadline`, and marks
  absentees when it closes. Roll calls from an activity show attendance on its
  post. The ✅-reaction tally is removed.

- **`/bug_report`** opens a form and creates a ticket in a hub forum instead of
  DMing admins. Before deploying, add a `bug_report.hub` block to Nijika's and
  Tomori's `config.json` (see [configuration](configuration.md)), invite both bots
  to the hub guild with the forum permissions listed there, and create the forum
  tags named in `bug_report.tags`. Without the block the command is disabled.

Register commands again after deploying so Discord shows the new options.

## Grouped slash commands

### Role and talk command migration

Replace `role_message`, `update_role` and `temp_role` in each bot's `commands`
with `role`, listed once. Their new paths are `/role panel`, `/role sync` and
`/role temp create`; `/role temp list` and `/role temp delete` are new. Keep the
`temp_role` configuration block and temporary-role lifecycle plugin. Existing
stored roles and claim buttons remain valid.

`temp_role.maxActivePerMember` defaults to `3` (integer `1`–`50`); new roles have
the `🔔 ` prefix and creation refuses existing names. `level_roles` values must be
role IDs; a role name makes the block invalid and disables `/role sync`.

Remove `talk_signed` from `commands` and enable `talk` once. `/talk` now signs
messages by default; choose `anonymous:true` for the previous unsigned behavior,
which still requires a configured bot admin. The destination channel is optional
and the sender's posting permissions are checked.

After updating configuration, deploy and register the affected bot's commands
again. The role and posting behavior is documented in
[configuration](configuration.md#roles-and-posting).

### Other grouped commands

Related commands now use subcommands. The old standalone slash commands and
configuration IDs have been removed; there are no compatibility aliases.

| Previous commands                                              | New invocation                                                    |
| -------------------------------------------------------------- | ----------------------------------------------------------------- |
| `feed_subscribe`, `feed_unsubscribe`, `feed_list`              | `/feed subscribe`, `/feed unsubscribe`, `/feed list`              |
| `add_reply`, `delete_reply`, `list_reply`                      | `/reply add`, `/reply delete`, `/reply list`                      |
| `activity_create`, `activity_delete`                           | `/activity create`, `/activity delete`                            |
| `giveaway_create`, `giveaway_delete`                           | `/giveaway create`, `/giveaway delete`                            |
| `ai_settings`, `ai_status`                                     | `/ai settings`, `/ai status`                                      |
| `ai_whitelist_add`, `ai_whitelist_remove`, `ai_whitelist_list` | `/ai whitelist add`, `/ai whitelist remove`, `/ai whitelist list` |
| `thread_ban`, `thread_allow`, `thread_list`, `thread_claim`    | `/thread ban`, `/thread allow`, `/thread list`, `/thread claim`   |
| `thread_manager add/remove/list`                               | `/thread manager add/remove/list`                                 |
| `traffic`, `traffic_me`, `traffic_user`                        | `/traffic overview`, `/traffic me`, `/traffic user`               |

1. In each bot's `config.json`, replace the corresponding `commands` entries
   with the root IDs `feed`, `reply`, `activity`, `giveaway`, `ai`, `thread`, and
   `traffic`. Include each enabled root once. A root enables all its actions;
   existing runtime permission checks still apply individually.
2. Restart the affected bots with the updated configuration. Register every bot's
   commands with `npm run register` (one bot: `npm run register -t <bot>`) to
   replace Discord's old entries;
   see [registration and guild-command pruning](contributing/local-setup.md#registering-slash-commands).
3. Review any custom Discord command permissions for the new roots. Discord
   command-level overrides apply to the root, while application authorization
   continues to run inside each action. Update saved instructions and shortcuts.

Options, stored data, button/modal identifiers, and per-action authorization
remain unchanged. `/help` shows root commands; its category and command detail
views list executable paths and options. Its command count counts
registered roots, not individual actions. Internal action modules are not public
command entries. See [configuration](configuration.md) for enabled-command setup.

## Message statistics commands

The statistics commands are rebuilt on the archive's statistics reader. Three
standalone commands are removed without aliases:

| Previous command     | Replacement                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `/emoji_frequency`   | `/traffic emoji`: `order` replaces `frequency`, `kind` replaces `type`, `range` replaces `last_n_months`; new `source` |
| `/sticker_frequency` | `/traffic sticker`: `order` replaces `frequency`, `range` replaces `last_n_months`                                     |
| `/db_list_message`   | None yet                                                                                                               |

`/traffic` adds `channel` and `apps`, the `90d` and `365d` ranges, and a dashboard
image per reply; `top_n` now stops at the rows a dashboard draws (5 for member,
channel and app rankings, 20 for emoji, 12 for stickers). Reports are
public by default (`visibility: ephemeral` keeps one private); refusals, notices and
errors stay private.

1. Remove `emoji_frequency`, `sticker_frequency` and `db_list_message` from each bot's
   `commands` in `config.json`; keep `traffic`. An unknown ID stops startup.
2. Deploy, then run `npm run register` (one bot: `npm run register -t <bot>`) so
   Discord drops the old commands and shows the new subcommands.

## Thread management controls

`/thread list` now uses private Previous/Next/Refresh buttons; remove its old
`page` option by registering the updated commands. Add `thread` to Nijika's configured command list to enable management
requests reviewed by DM and direct admin grants. Requests use existing
`config.admin` IDs and require no review-channel configuration.

Existing ban documents remain valid; delegated-management fields default to
empty values. The new message-source collection expires source IDs after seven
days. Nijika can now delete attributable public replies from other bots, while
unknown origins and private responses remain outside this mechanism. See
[thread moderation](thread-moderation.md) for scope, recovery and permissions.

For routine updates, see [deployment](contributing/deployment.md); for current
settings, see [Configuration](configuration.md).

## Social feed

The `x_media_feed` block is replaced by `social_feed` and is ignored without a
startup error. Configure `social_feed` as in the
[nijika example](../src/bot/nijika/config.example.json), enable `feed`, and recreate
subscriptions with `/feed subscribe`; old cursors are not migrated. The retired
`xfeedcursors` collection is no longer read and can be dropped.

## Recording removal rollout

Remove `record` from bots' `commands`, stop old processes, start updated bots and
re-register commands to remove `/record` from Discord.

Existing `data/voice_record` files and FFmpeg installations remain; setup no longer
installs FFmpeg. Voice/stage channel text-message backups remain supported.

## Message archive worker and tools

Stop the old msg-archive worker and standalone `msg_backup` processes before
starting the new writer. Upgrade reader bots together: they no longer initialize
archive indexes or receive mutation repositories. The `tools/msg_backup` adapter and
message-only `db` operations are removed; use
[Discord archive controls](message-archive.md#discord-controls). msg-archive always
registers exactly `/archive`, so its `commands` list needs no entry; configure each
guild's debug channel, deploy, and run `npm run register -t msg-archive`.

Periodic history scans default to disabled per guild; enable the schedule after the
first full backup. Existing `backup_interval_minutes` provides only the initial
interval; saved command settings take precedence. See
[schedule controls](message-archive.md#periodic-schedule) and
[capacity and recovery](message-archive.md#capacity-and-recovery).

### Full backup replaces the repair flow

The one-shot repair workflow (plan → apply → verify → accept → rollback) is retired
with its recovery data, and `/archive` is redesigned. After deploying, register
msg-archive's commands again with `npm run register -t msg-archive`.

- **Commands.** `/archive backup`, `/archive status` and
  `/archive schedule [enabled] [minutes]` remain. `/archive jobs`, `/archive plans`
  and `/archive schedule status|enable|disable|interval` are removed: use
  `/archive schedule` without options to show the schedule, `enabled:true|false`
  instead of `enable`/`disable`, and `minutes:<value>` instead of `interval`.
- **Full backup.** `/archive backup` starts a [full backup](message-archive.md#full-backup)
  after one confirmation. It needs no acceptance step and has no rollback; job
  records are pruned automatically to the ten newest finished ones.
- **Access.** `/archive` requires the user to be in msg-archive's `admin` list
  ([configuration](configuration.md#common-bot-settings)); server owners and Manage
  Server holders no longer qualify automatically. Add every operator to `admin`
  before deploying.
- **Notifications.** Periodic passes no longer post progress cards. The debug
  channel gets one notice after three consecutive failed passes and one when a
  pass completes again.
- **Data.** Collections of the old flow (`archive_repair_*`, `archive_journals`,
  `archive_quarantine`, `archive_plan_deletions`, `archive_control_deletions`,
  `archive_bulk_*`, `archive_progress_details`) are no longer read or written and
  can be dropped once backed up.

### Archive runtime settings

`archive_runtime.progress_interval_seconds` is removed; public progress always
refreshes every ten seconds. `archive_runtime` rejects unknown keys, so delete the
key from msg-archive's `config.json` before deploying, or startup and
`npm run deploy:prepare` fail. Progress snapshots saved by earlier releases
(version 1 or unversioned) are no longer read; their job or run shows no progress
until it saves a new one.

### Message schema 3

msg-archive writes only schema 3 `messages` documents and never reads or converts
earlier ones. A `messages` collection that still has the legacy `messageId_1`
index, holds documents without the schema 3 indexes (`createdTimestamp_1`,
`channelId_1_createdTimestamp_1`), or holds documents of an earlier schema keeps the
guild in capture-only mode, where live events only queue in `archive_inbox`. The
`db archive-legacy-*` rebuild tools have been removed; an archive still in an
earlier schema must be rebuilt with an earlier release's tools before upgrading.

- The Discord message ID is `_id`; field names follow discord.js
  (`author { id, username, globalName, bot }`, `createdTimestamp`,
  `reference.messageId`, `messageSnapshots` …). `guildId`, `channelName`,
  `channelParentId`, `contentHash`, `presence`, `authorKind`, `source`,
  `firstObservedAt` and the attachment `spoiler`/`urlObservedAt` fields are gone.
  See [message documents](message-archive.md#message-documents).
- `archive_revisions` is no longer written. Up to 50 previous versions live in each
  message's `editHistory`; `editHistoryDropped` counts older ones.
- Attachment and Discord media URLs are stored without their expiring signature.
- Channel names, parents and `everyoneCanView` live in `archive_channels`, which
  channel events and live capture now update; deleted channels keep their record.
  `archive_reactions` chunks record their message's `channelId`, and reaction keys
  are the custom emoji ID or the Unicode emoji (no `custom:`/`unicode:` prefix);
  `reactionGenerations` keys add `:0` (normal) or `:1` (burst).
- Bot replies to interactions that no `archive_policy` rule names are now kept as
  interaction records (no content). Add an `exclude` rule for a bot whose command
  use should not be recorded. Policy changes never remove stored messages. See
  [archive policy](configuration.md#archive-policy).
- Progress no longer reports format upgrades or lower-bound counts. A channel whose
  only checkpoint predates per-kind checkpoints is scanned from the start.

`/traffic` reads schema 3; its statistics stay incomplete until the first full backup
completes.

## Deleted-attachment archive layout

Newly archived files are stored at
`data/deleted_attachments/<guildId>/<messageId>/<YYYY-MM-DD_HH-MM-SS>_<name>`
(see [attachment storage](configuration.md#attachment-storage)). Files archived
earlier keep the previous flat `data/deleted_attachments/<guildId>/<localized
timestamp> <name>` naming; they are not moved or renamed, and retention is still
unlimited. No configuration change is required.
