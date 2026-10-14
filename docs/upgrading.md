# Upgrade notes

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
- **`/level_detail`** takes `rank_from` and `count` (1-10) instead of `left` and
  `right`.
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

Register commands again after deploying so Discord shows the new options.

## Grouped slash commands

### Role and talk command migration

Replace `role_message`, `update_role` and `temp_role` in each bot's `commands`
with `role`, listed once. Their new paths are `/role panel`, `/role sync` and
`/role temp create`; `/role temp list` and `/role temp delete` are new. Keep the
`temp_role` configuration block and temporary-role lifecycle plugin. Existing
stored roles and claim buttons remain valid.

`temp_role.maxActivePerMember` defaults to `3` (integer `1`–`50`); new roles have
the `🔔 ` prefix and creation refuses existing names. Migrate `level_roles` values
from role names to IDs; legacy names still resolve with a warning.

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

## Migrating from `x_media_feed` to `social_feed`

A remaining `x_media_feed` block prevents startup. Subscriptions now live in guild databases.

1. Save `accounts` and `defaultChannel` for recreating subscriptions.
2. Rename the block to `social_feed`; move `apiBaseUrl`, `timeoutMs` and
   `embedProxyHost` under `platforms.x`. Keep the polling options, but note that
   `maxPostsPerPoll` now applies per subscription, not per account. Follow the
   [nijika example](../src/bot/nijika/config.example.json).
3. Remove `accounts`, `defaultChannel` and the unused `guilds.<id>.channels.x_feed` mapping.
4. Add `feed` to `commands`, then
   run `npm run register -t nijika`; review the
   [guild-command pruning behavior](contributing/local-setup.md#registering-slash-commands).
5. Recreate subscriptions with `/feed subscribe` (up to 20 accounts per call),
   specifying destination and media filter. Check failures and unattempted accounts.

New subscriptions do not backfill posts or migrate old cursors. To remove retired
`xfeedcursors` collections, follow the [database tool guide](../tools/db/README.md#db-drop-xfeed).
`npm run db -- drop-xfeed` counts only until `dry_run: false` is configured.

## Recording removal rollout

Remove `record` from bots' `commands`, stop old processes, start updated bots and
re-register commands to remove `/record` from Discord.

Existing `data/voice_record` files and FFmpeg installations remain; setup no longer
installs FFmpeg. Voice/stage channel text-message backups remain supported.

## Message archive worker and tools

Stop the old msg-archive worker and standalone `msg_backup` processes before
starting the new writer. Upgrade reader bots together: they no longer initialize
archive indexes or receive mutation repositories. Their guild-events attachment
cache/deletion behavior is unchanged.

The `tools/msg_backup` adapter and message-only `db` operations have been removed.
Use [Discord archive controls](message-archive.md#discord-controls) for archive
work. Add `archive`
to msg-archive's local `commands`, configure each guild's debug channel, deploy,
and register with `npm run register -t msg-archive`. Existing local
`tools/db/config.json` credentials and `report.json` results are preserved; retired
operation sections can be removed manually when no longer needed. Unrelated
collection cleanup and whole-database migration remain available in their tools.
Archive writes and timestamp/index work belong to msg-archive. Empty bot/webhook
allowlists do not remove existing unknown-source rows.

Review [capacity and recovery](message-archive.md#capacity-and-recovery) before rollout.
Legacy duplicates can leave the worker in capture-only mode until the
[rebuild](#rebuilding-the-message-archive) replaces them. Existing identity/query fields are preserved;
startup performs no bulk data conversion.

Periodic history scans now default to disabled per guild. Add `archive` to the
local msg-archive `commands` list, redeploy and register commands, then explicitly
enable the schedule after the first full backup. Live capture remains active. Existing
`backup_interval_minutes` provides only the initial interval; saved command
settings take precedence. See [schedule controls](message-archive.md#periodic-schedule).

### Archive batching and progress contracts

Drain the existing writer before changing executors; code preparation does not
interrupt an active run. New repair plans use journal version 2 and a distinct
schema identity. The new executor keeps the original per-operation apply/capture
protocol for version 1 or unversioned runs. Version 2 permits durable sequence
reservations and bounded independent mutation batches; gaps in sequence numbers
are valid and do not represent missing committed operations. Unknown journal
versions are rejected. The schema identity also makes older executors reject new
version 2 runs instead of reusing their sequence numbers. Keep a compatible release
available while those runs still need execution or retained rollback recovery.

Progress snapshots use version 2. History checkpoint version 2 adds acknowledged
page counters; legacy cursors remain readable, but absent counters are not invented
as exact totals. Concurrency defaults to 2, with accepted range 1–8. Public notifications now
use a fixed ten-second cadence: remove the previous `progress_interval_seconds`
override or set it to `10` before deployment. Other explicit intervals are rejected. Deploy preparation now validates the
same archive settings as plugin startup before service cutover. No database-wide
migration is required.

### Guided archive controls

These controls are retired; see
[full backup replaces the repair flow](#full-backup-replaces-the-repair-flow).

Register commands again to expose `/archive schedule enable [minutes]`. Existing
schedule settings and command names remain valid; the optional interval and enable
change are saved together. Repeating existing settings no longer changes the next
backup time. Routine progress omits internal steps and duplicate counters while
retaining problems, recovery actions and incomplete-count indicators.

After deploying the updated msg-archive release, register its command metadata
with `npm run register -t msg-archive` to expose the four entry points:
`backup`, `jobs`, `plans` and `schedule`. Reopen job/plan lists after deployment to
use button-only pages: two entries per list page and at most five controls.
Eligible deletion and rollback appear directly; whole-list deletion opens an
all-pages review. Active-only filtering and
combined single-item stop-and-delete buttons are removed from new pages. Existing
select interactions remain compatible and refresh into buttons. Apply, resume and
acceptance retain scoped confirmation. Audit, standalone verification and
attachment-refresh entry points remain retired.
No repair-journal migration is required; apply the ten-second notification setting
above before deployment.
Existing run/job identities remain usable. Old debug messages
without a panel button can be recovered through `jobs` or `plans`;
new notifications host shared public status and detail views in the same message.
Buttons now navigate within their own message instead of redirecting edits to the
selected job's original notification. Reopened lists provide independent panels;
background updates leave panels browsing another target alone. New confirmation
records persist their exact displayed message; existing records retain the original
notification fallback. No data migration is required for these optional display fields.
Reopen any pending confirmation after the update: confirmation fingerprints now
also bind the displayed mutation impact, so older unconsumed buttons may be stale.
Already submitted jobs and durable repair journals remain valid. Single-item
delete approvals are short-lived and must be requested again after restart; accepted deletion
requests and replay tombstones persist. No bulk deletion or journal migration is
performed by this update. **Delete all jobs** and **Delete all plans** create
five-minute, actor/channel/message-bound reviews of exact identities across all
pages. Existing accepted bulk cleanup retains result/resume controls and its
original safety checks; later arrivals and protected repair data remain excluded.
Single and bulk plan deletion now also accept fully rolled-back plans when no
conflicts, recovery journals, active consumers or jobs remain. All operations must
be rolled back or still planned without ever mutating data. Incomplete rollback
and remaining applied changes stay protected; archived messages are preserved.
Plan deletion followed the rules of that release.

Target-aware inspection reads allowlisted fields from existing journal images;
it does not require rebuilding old plans or migrating recovery data. Missing
historical identities are explicitly marked unknown. Shared public navigation
uses short-lived, context-bound view tokens: after expiry or a process restart,
reopen the durable job/run with `jobs` or `plans`. Only the browsing
position expires; submitted work and approval records remain durable. Change
lists update one public message. **View details** shows up to ten concrete changes,
at most five per page; larger plans show grouped impacts with source examples.
Category, source and individual-operation drilldowns, technical pages and public
downloads have been removed. Old detail buttons open the compact changes view.
Routine views omit internal IDs and hashes; meaningful source IDs remain available.
Public progress offers details and stop controls and keeps the same ten-second card.

The guided flow removes the redundant manual
verify step after a successful apply. It does not automatically accept results or
enable periodic scans. Acceptance still checks current data and explicitly starts
the recovery retention period.

Rollback conditional writes now combine a native `_id` equality predicate with
the existing complete-document comparison. This lets MongoDB use its ID index
without weakening protection against later edits. No index or data migration is
needed; recovery remains sequential and preserves its journal order.

### Live inbox retry counters

`archive_inbox.attempts` now counts only failed reconciliations that were the
event's fault. Earlier versions incremented it on every claim, so values written
before this change are inflated by capacity waits and releases; such an event can
be dead-lettered on its next counted failure. A new `claims` field tracks claims
that end without any outcome, and dead letters (`state: "dead"`) expire through a
30-day TTL index on `deadAt`, created by the worker at startup. The archive rebuild
below moves the old inbox aside, so a rebuilt archive starts with clean counters.

### Full backup replaces the repair flow

The one-shot repair workflow (plan → apply → verify → accept → 72-hour rollback)
is retired with its recovery data, and `/archive` is redesigned. After deploying,
register msg-archive's commands again with `npm run register -t msg-archive`.

- **Commands.** `/archive backup`, `/archive status` and
  `/archive schedule [enabled] [minutes]` remain. `/archive jobs`, `/archive plans`
  and `/archive schedule status|enable|disable|interval` are removed: use
  `/archive schedule` without options to show the schedule, `enabled:true|false`
  instead of `enable`/`disable`, and `minutes:<value>` instead of `interval`.
- **Full backup.** `/archive backup` starts a [full backup](message-archive.md#full-backup)
  after one confirmation: a fixed cutoff, per-channel checkpoints kept apart from
  periodic ones, cooperative stop and resume, and automatic continuation after a
  restart. It needs no acceptance step and has no rollback. Plans, journals,
  quarantine and job or plan deletion are gone; job records are pruned
  automatically to the ten newest finished ones.
- **Access.** `/archive` now requires the user to be in msg-archive's `admin` list
  ([configuration](configuration.md#common-bot-settings)); server owners and Manage
  Server holders no longer qualify automatically. Add every operator to `admin`
  before deploying. The command no longer sets a Discord default member permission,
  so every member sees it and non-admins get a private refusal. The debug channel
  and `backup_server` requirements are unchanged.
- **Notifications.** Periodic passes no longer post progress cards. The debug
  channel gets one notice after three consecutive failed passes and one when a
  pass completes again.
- **Old panels.** Buttons, menus and forms on messages from earlier versions no
  longer act; Discord reports the interaction as failed and the old message stays
  as it is. Run the command again for a current panel.
- **Data.** Plan, journal, quarantine and control collections of the old flow
  (`archive_repair_*`, `archive_journals`, `archive_quarantine`,
  `archive_plan_deletions`, `archive_control_deletions`, `archive_bulk_*`,
  `archive_progress_details`) are no longer read or written. The
  [rebuild](#rebuilding-the-message-archive) removes them; until then they are
  inert. Unfinished repair runs cannot be resumed or rolled back after this update.
  The new `archive_storage_usage` (host storage sample) and `archive_control_confirmations`
  (start approvals, expired by a TTL index on `purgeAt`) are metadata the rebuild
  also drops.
  A history checkpoint from before this update is reused only by the periodic run
  that wrote it.

### Rebuilding the message archive

The legacy message archive is retired by a rebuild rather than migrated. With
msg-archive stopped and every guild database backed up with `mongodump`, move the
legacy collections aside, run a full backup with the new design, export the legacy
messages that backup cannot reproduce (and any unprocessed live events) into a
verified zip, then drop the legacy data. The `db` CLI provides the three dry-run-by-default steps:
`archive-legacy-isolate`, `archive-legacy-export` and `archive-legacy-drop`. Their
preconditions, options and export format are in the
[`db` tool reference](../tools/db/README.md#legacy-message-archive-rebuild).
Export and drop need the `zip` and `unzip` binaries: re-run
`bash scripts/setup-env.sh` (after undeploying managed services) to install them
from `environment.yml`.

Run the rebuild one step at a time and check each report before the next step:

1. **Prepare.** Deploy the new release without starting msg-archive. If the host
   storage check may pause background work while the `legacy_*` collections still
   count towards usage, raise `storage.background_limit_bytes` temporarily.
2. **Back up.** Stop msg-archive, run `mongodump --gzip` for every guild database
   to a location outside the storage budget, and restore it once into a scratch
   database to confirm the document counts before deleting the scratch copy.
3. **Isolate.** Run `npm run db -- archive-legacy-isolate` as a dry run, review the
   report, then set `dry_run: false` and run it again. Note the reported
   `legacy_timestamp`.
4. **Full backup.** Start msg-archive (it creates the schema 3 indexes on start),
   then run `/archive backup` in each guild's debug channel and confirm. Wait for
   it to finish. Continue or restart it until only known coverage gaps remain;
   a transient failure would otherwise make that channel's legacy messages look
   missing.
5. **Export.** Run `npm run db -- archive-legacy-export` as a dry run and check
   the per-category counts; stop and investigate if `message-missing` is
   unexpectedly large. Then set `dry_run: false`, confirm the report says the
   archive verified, and open one file per category from the zip as a spot check.
   The zip stays in `tools/db/backups/` (mode 0600, private channel content).
6. **Drop.** Run `npm run db -- archive-legacy-drop` as a dry run, review the
   listed collections, then set `dry_run: false`. Delete the `mongodump` files
   from step 2 afterwards.
7. **Resume.** Run `/archive schedule enabled:true`, restore any limit raised in
   step 1, update the production `config.json` files (the msg-archive `admin`
   list must contain everyone who operates `/archive`; remove `emoji_frequency`,
   `sticker_frequency` and `db_list_message` from the bots that listed them),
   restart msg-archive and the reader bots, and run `npm run register` so Discord
   shows every bot's new command list.
8. **Verify.** Watch the first two periodic passes: the cutoff advances and the
   second pass is incremental. Run `/traffic overview` and `/traffic me` and check
   on desktop and mobile that both dashboard images stay readable.

### Message schema 3

msg-archive now writes only schema 3 `messages` documents and never reads or
converts earlier ones. Isolate the legacy archive with `archive-legacy-isolate`
before starting the new worker: a `messages` collection that still has the legacy
`messageId_1` index, holds documents without the schema 3 indexes
(`createdTimestamp_1`, `channelId_1_createdTimestamp_1`), or holds documents of an
earlier schema keeps the guild in capture-only mode, where live events only queue
in `archive_inbox`.

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
after the rebuild completes.

## Deleted-attachment archive layout

Newly archived files are stored at
`data/deleted_attachments/<guildId>/<messageId>/<YYYY-MM-DD_HH-MM-SS>_<name>`
(see [attachment storage](configuration.md#attachment-storage)). Files archived
earlier keep the previous flat `data/deleted_attachments/<guildId>/<localized
timestamp> <name>` naming; they are not moved or renamed, and retention is still
unlimited. No configuration change is required.
