# Upgrade notes

## Grouped slash commands

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
2. Restart the affected bots with the updated configuration. Register each bot's
   commands with `npm run register -- -t <bot>` to replace Discord's old entries;
   see [registration and guild-command pruning](contributing/local-setup.md#registering-slash-commands).
3. Review any custom Discord command permissions for the new roots. Discord
   command-level overrides apply to the root, while application authorization
   continues to run inside each action. Update saved instructions and shortcuts.

Options, stored data, button/modal identifiers, and per-action authorization
remain unchanged. `/help` lists full executable paths; its command count counts
registered roots, not individual actions. Internal action modules are not public
command entries. See [configuration](configuration.md) for enabled-command setup.

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
   run `npm run register -- -t nijika`; review the
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
Use [Discord archive controls](message-archive.md#discord-controls) for planning,
timestamp repair, automatic verification, job inspection and recovery. Add `archive`
to msg-archive's local `commands`, configure each guild's debug channel, deploy,
and register with `npm run register -- -t msg-archive`. Existing local
`tools/db/config.json` credentials and `report.json` results are preserved; retired
operation sections can be removed manually when no longer needed. Unrelated
collection cleanup and whole-database migration remain available in their tools.
Archive writes and timestamp/index work belong to msg-archive. Empty bot/webhook
allowlists do not remove existing unknown-source rows.

Review [capacity and recovery](message-archive.md#capacity-and-recovery) before rollout.
Legacy duplicates can leave the worker in capture-only mode until a reviewed repair
establishes the unique message index. Existing identity/query fields are preserved;
startup performs no bulk data conversion.

Periodic history scans now default to disabled per guild. Add `archive` to the
local msg-archive `commands` list, redeploy and register commands, then explicitly
enable the schedule after repair. Live capture remains active. Existing
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

Register commands again to expose `/archive schedule enable [minutes]`. Existing
schedule settings and command names remain valid; the optional interval and enable
change are saved together. Repeating existing settings no longer changes the next
backup time. Routine progress omits internal steps and duplicate counters while
retaining problems, recovery actions and incomplete-count indicators.

After deploying the updated msg-archive release, register its command metadata
with `npm run register -- -t msg-archive` to expose the four entry points:
`backup`, `jobs`, `plans` and `schedule`. Reopen job/plan lists after deployment to
use button-only pages: two entries per list page and at most five controls.
Eligible deletion and rollback appear directly; whole-list deletion opens an
[all-pages review](message-archive.md#bulk-deletion). Active-only filtering and
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
See the [plan deletion rules](message-archive.md#discord-controls).

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

The [guided flow](message-archive.md#one-shot-repair) removes the redundant manual
verify step after a successful apply. It does not automatically accept results or
enable periodic scans. Acceptance still checks current data and explicitly starts
the recovery retention period.

Rollback conditional writes now combine a native `_id` equality predicate with
the existing complete-document comparison. This lets MongoDB use its ID index
without weakening protection against later edits. No index or data migration is
needed; recovery remains sequential and preserves its journal order.
