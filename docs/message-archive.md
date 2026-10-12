# Message archive

`msg-archive` owns message capture and backup writes. Other bots may read archived
messages; their existing attachment caches and deleted-file archives continue
independently. Administrators manage the full backup and periodic schedule through
`/archive` in Discord; msg-archive remains the only archive writer.

## Scope and retention

`backup_server` selects guilds. Discovery covers text/announcement channels,
voice/stage chat, active and archived threads, and forum/media posts. Previously
known locations are rechecked. Missing permissions, unsupported types and
incomplete private-thread discovery remain coverage gaps, never empty history.

Humans are included. Bot and webhook messages are kept only by an
[`archive_policy`](configuration.md#archive-policy) `include` rule; a bot reply to
an interaction that no rule names keeps only its interaction record. Unknown
authors are retained for classification; policy changes do not automatically
delete existing records.

| Content                 | Retained data                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| Messages                | Latest text, author (ID, username, display name, bot flag), source IDs, times, embeds, mentions, reply target  |
| Edits and deletions     | Up to 50 previous versions per message and the deletion time; the content stays after deletion                 |
| Attachments             | Identity, name, alt text, type, size, dimensions and the CDN location without its signature; no file downloads |
| Reactions               | Counts per emoji, complete normal and burst (Super Reaction) user lists with freshness status                  |
| Stickers and polls      | Sticker ID/name/format; poll question, options and vote counts, without voter lists                            |
| Components and forwards | Readable labels, choices and links; one level of forwarded message content                                     |
| Interaction records     | Author, application, interaction ID/type/user/target and message type of an unlisted bot's interaction reply   |

Raw API payloads, interaction tokens and command names, avatars, voice waveforms
and per-event reaction histories are excluded.

### Message documents

`messages` holds one document per message, schema version 3. Field names follow
discord.js; [`message.schema.ts`](../src/persistence/schemas/message.schema.ts)
defines them and the [normalization contract](../src/core/archive/normalize.ts)
maps Discord payloads onto them. An absent field was not observed; an empty array
or `null` means Discord reported none.

| Field                                                                                        | Content                                                                                               |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `_id`, `schemaVersion`, `channelId`                                                          | Discord message ID (the primary key), always `3`, and the channel or thread                           |
| `author { id, username, globalName, bot }`, `webhookId`, `applicationId`                     | Who sent it, as last observed; names are not updated after a rename                                   |
| `interactionMetadata { id, type, user, targetUserId, targetMessageId, interactedMessageId }` | The interaction a bot reply answers (from `interaction_metadata`; no command name)                    |
| `type`, `flags`, `content`, `createdTimestamp`, `editedTimestamp`                            | Message type and flags, current text, creation and last edit time (`null`: never edited)              |
| `attachments`, `stickers`, `embeds`, `components`, `poll`, `messageSnapshots`                | Content structures; components are stored as normalized trees up to eight levels deep                 |
| `reactions[] { emoji, count, countDetails }`                                                 | Reaction counts; a reaction is identified by its custom emoji ID or Unicode emoji                     |
| `mentions { users, roles, channels, everyone }`, `thread { id, name, type }`                 | Mentioned IDs and the thread started from the message                                                 |
| `reference { guildId, channelId, messageId, type, authorId }`                                | The referenced message; `authorId` is the replied-to author while Discord still provides it           |
| `editHistory[]`, `editHistoryDropped`                                                        | Previous versions, oldest first, and how many were dropped                                            |
| `excludedFields`, `policy { version, ruleId, reason }`                                       | Fields the policy deliberately does not keep, and why a bot, webhook or unclassified message was kept |
| `observedAt`, `deletedAt`, `reactionGenerations`, `reactionsFreshAt`, `reactionsStaleAt`     | Backup metadata: last observation, deletion, published membership lists and their freshness           |

The guild is the database itself. Channel names, types, parents and visibility
live in `archive_channels`, not in each message: discovery and channel events keep
one record per channel or thread, live capture records a channel it does not know
yet, and the record of a deleted channel is kept (`access: "deleted"`) with its
last name, parent and `everyoneCanView`, whether `@everyone` could view it when
last checked. A thread's value is recorded when the thread itself is observed and
can lag behind permission changes of its parent, so readers judge a thread through
its parent's record. Reaction user lists live in `archive_reactions`, one document
per chunk with its message and channel. A message's `reactionGenerations` is keyed
by the reaction (custom emoji ID or Unicode emoji) plus `:0` for normal or `:1` for
burst users.

**Writes.** Each observation is compared with the stored document. An observation
older than the stored content (an earlier edit time, or the same version observed
earlier) replaces nothing; it only fills fields the document lacks. A newer one
replaces only the fields it carries, so a partial Gateway update never erases the
others; `mentions` and `reference` merge per field, and a poll observed without
results keeps the stored vote counts. Replays and signature refreshes change
nothing. A live update that does not name its author stores only the message's
identity until the following REST read classifies it; a message the policy then
rejects is removed.

**Tombstones.** A deletion of a message the archive never observed leaves a bare
tombstone: `_id`, `schemaVersion`, `channelId`, `createdTimestamp`, `observedAt` and
`deletedAt`, without `author` or content. It keeps a create that arrives after the
deletion from reviving the message: that observation only fills the tombstone,
which stays deleted. Readers must skip documents without `author`.

**Edit history.** When the edit time changes, the previous `content`,
`attachments`, `embeds` and `components` move into `editHistory` in the same write.
Link previews, poll votes and reactions are not edits. Only versions the bot saw
are recorded: several edits while it was offline leave only the last. At most 50
previous versions are kept per message; older ones are dropped and counted in
`editHistoryDropped`. Interaction records keep no content and no history.

**Attachment URLs.** Discord signs CDN URLs (`ex`, `is`, `hm`) and they expire
after about a day, so the archive stores the unsigned location, which identifies
the file but does not open it. To open a file, fetch its message again through the
Discord API while the message exists. Once a message or channel is deleted, its
files cannot be retrieved; the archive never downloads them.

Deleted messages never captured and edits made while the bot was offline cannot be
recovered. Incomplete reaction refreshes preserve the previous complete membership.
See [configuration](configuration.md#message-archive).

## Discord controls

Register `/archive` on msg-archive after adding `archive` to its local `commands`:
`npm run register -t msg-archive`. Deployment and command registration remain
host operations.

| Command                                                        | Purpose                                                     |
| -------------------------------------------------------------- | ----------------------------------------------------------- |
| `/archive backup`                                              | Start, resume or stop the full backup                       |
| `/archive status`                                              | Show every archive status in one panel                      |
| `/archive schedule [enabled:<true/false>] [minutes:<1–10080>]` | Show the periodic schedule; with options, change only those |

Panels are public messages in the debug channel, including channel names, gap
details and recent records. Buttons update the message they belong to, with at most
five per page. Routine views omit internal IDs, hashes and message content.

### Access and confirmations

Every command and every button press checks, in this order:

- The user is in msg-archive's `admin` list ([configuration](configuration.md#common-bot-settings)).
  Server owners and Manage Server holders are not implied; add them to the list.
  Removing someone from the list stops them from using old panels too.
- The guild is listed in `backup_server`.
- The command runs in the guild's configured `guilds.<guildId>.channels.debug`
  channel, where the bot can view the channel, send messages and embed links.
- The bot is msg-archive, the only archive writer, and the guild's database
  connected at startup (otherwise the reply names the startup error ID).

The command sets no Discord default member permission, so every member sees it;
anyone outside the `admin` list gets a private refusal and nothing is posted.
Rejected buttons reply privately and leave the shared panel unchanged. Buttons,
menus and forms on panels from earlier versions skip these checks and only reply
privately that the panel is out of date.

Only starting a full backup asks for confirmation. The confirmation is bound to the
administrator who opened it, its channel and its message, expires after five
minutes, is stored in `archive_control_confirmations` and survives restarts. A
second click or a replay returns the backup already created instead of a new one.

### Full backup panel

`/archive backup` opens one of three panels:

- **No unfinished backup:** a confirmation showing the server, the readable channels
  and gaps found by the last discovery (or that discovery happens at start) and the
  effect: periodic backup pauses meanwhile, live capture continues, and the backup
  can be stopped and resumed. **Start backup** turns the same message into the
  progress panel; **Cancel** closes it.
- **A backup is queued or running:** its progress panel. The panel moves to this
  message; the old message stops updating.
- **The newest backup is stopped or failed:** its final panel with **Resume**,
  **Start over** and **Gap details**. **Start over** opens a confirmation that keeps
  the already backed-up data but uses a new cutoff.

The progress panel updates every ten seconds and at once when the state changes. It
shows the current activity (channel and page, and whether it is fetching, writing or
reading reactions), channels done out of discovered with the gap count, messages
scanned, written and unchanged, messages whose reaction lists were completed or left
incomplete, the recent speed, the cutoff, the run time and the last update. Its
title is the state:

| Title                | Meaning                                              |
| -------------------- | ---------------------------------------------------- |
| Waiting to start     | Queued; the worker starts it on its next poll        |
| Running              | **Stop** and **Gap details** are available           |
| Stopping             | The stop is waiting for a safe boundary              |
| Complete             | Every channel finished                               |
| Complete (with gaps) | Only known gaps remain, such as missing permissions  |
| Stopped              | Stopped by an administrator; **Resume** is available |
| Failed               | Shows the reason category; **Resume** is available   |

A finished panel keeps **Gap details**, plus **Resume** while the backup is the newest
one and stopped or failed. If the panel message is deleted, the result is not posted
again; `/archive status` still shows it.

**Gap details** lists the channels the bot cannot back up, grouped by reason
(missing permissions, deleted, unresolved), ten per page, with **Previous**, **Next**
and **Back**. While it is open on a backup's panel, progress updates leave the page
alone; **Back** shows the current progress.

### Status panel

`/archive status` shows:

| Field           | Content                                                                                 |
| --------------- | --------------------------------------------------------------------------------------- |
| Full backup     | The newest full backup's result and end time, or its progress while it runs             |
| Periodic backup | Enabled or disabled, interval, last complete pass and next run; progress while one runs |
| Coverage        | Channels readable at the last discovery and gaps by reason                              |
| Live capture    | Time since capture was last possibly lossy, events awaiting write, abandoned events     |
| Capacity        | Message backup size and the host total against its budget                               |

- **Live capture.** Gateway events wait in `archive_inbox` until written. The
  continuous time restarts at the last point events may have been missed: a restart
  or a new Gateway session (a resumed session replays missed events and does not
  count). Periodic backup rescans that window. Events awaiting write should stay
  near zero; abandoned events are [dead letters](#live-capture-inbox) and need a look
  at the log when above zero.
- **Capacity.** _Message backup_ is the data and indexes of this guild's `messages`
  and `archive_*` collections from MongoDB's statistics. _Host overall_ is the
  worker's last measurement of every managed storage root (the project directory,
  the Node runtime, the whole MongoDB data directory and `storage.additional_roots`)
  against `storage.budget_bytes`, with when it was measured; background writes pause
  by that number. The worker samples every 15 seconds. The MongoDB data directory
  (live) is walked on every sample. The project directory, the Node runtime and
  `storage.additional_roots` (stable) change through deployments, logs and
  attachment archives; their size is reused for ten minutes and then walked again as
  part of the next sample, and on every sample once usage reaches 90% of the budget.
  Growth outside the MongoDB data directory therefore shows within about ten minutes
  while usage is below 90%. Sampling runs in the background: a write does not wait
  for a sample while the previous one is less than a minute old, and a failed sample
  is logged (`Archive storage sample failed`). The worker saves the measurement in
  `archive_storage_usage` at most once a minute, with when the stable roots were last
  walked (`stableMeasuredAt`). Either value shows as unknown when unavailable.

**Recent records** lists the retained full-backup and periodic-pass records with
type, result, start time and duration. The worker keeps the ten newest finished
records and prunes older ones when a backup or pass ends. It never prunes a queued
or running backup, the newest complete full backup (the rebuild tools read its
cutoff) or the newest full backup while it can still resume.

## Periodic schedule

Periodic history scans default to disabled, including existing installations
without saved settings. Gateway capture and full backups remain active. Settings
live in each guild's `archive_schedule` collection and survive restarts. Use
`/archive schedule` in the configured debug channel under the same
[access rules](#access-and-confirmations) as every archive command.

| Command                                     | Behavior                                                             |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `/archive schedule`                         | Show status, interval and next run                                   |
| `/archive schedule enabled:true`            | Enable; a disabled schedule runs a pass at once                      |
| `/archive schedule enabled:false`           | Stop new passes; a running pass pauses at a safe boundary            |
| `/archive schedule minutes:<value>`         | Set 1–10080 minutes without changing whether the schedule is enabled |
| `/archive schedule enabled:true minutes:60` | Set the interval and enable the schedule in one step                 |

The reply marks the settings that changed, explains when the change takes effect
and notes when a full backup is running, which pauses periodic passes. Repeating a
saved setting changes nothing and keeps the next run time.

The interval normally starts after a pass that reached the end of its scan,
whether complete or partial. A pass interrupted before its end (preempted by a
full backup, paused for storage headroom, shut down) or one the worker could not
start is retried after one minute. A pass that ends with an unexpected error backs
off: one minute, then two, four and so on, resetting after the next pass that
reaches its end. Every retry delay is capped at the interval. Changing the interval
on an enabled schedule schedules the next pass from the change time; the current
pass is not restarted or overlapped. Enabling a disabled schedule makes a pass due
immediately. A disabled running pass preserves checkpoints; enabling resumes that
pass before starting a fresh one. In-flight requests may finish before a pause is
observed. Schedule changes never stop a full backup or live capture.

Passes post nothing to Discord while they succeed. After three consecutive passes
end failed (with blocking failures or an unexpected error, or skipped because the
guild is in capture-only mode), the debug channel gets one notice with the failure
count, the latest reason category and the next retry time. Further failures send
nothing until a pass completes, which sends one recovered notice. _Complete with
gaps_ is not a failure; interrupted passes neither count nor reset the streak.

The streak and the pending notice live in `archive_schedule`, so a restart does
not lose a notice. Delivery is at least once: a crash between sending and recording
the send can repeat it. A failed send is retried before later passes, waiting one
minute and doubling up to one hour; if Discord refuses permanently (the channel is
gone or the bot lost access) the notice is dropped and the worker logs
`Archive schedule notice refused by Discord; not retried`. Only the newest notice
is kept: when a pass completes before an earlier failing notice could be sent, the
recovered notice replaces it.

Normal incremental passes revisit messages since each completed source watermark,
including the configured overlap window, and keep reaction lists that Gateway
capture proves unchanged instead of rereading them (see
[backup throughput](#backup-throughput)). Only a Gateway gap requires a full
reconciliation; a restart or a replaced Gateway session rescans its downtime
incrementally (see
[restarts, Gateway gaps and channel changes](#restarts-gateway-gaps-and-channel-changes)).
Each pass finishes its run in one of two states:

- **Complete** — every reachable source finished. Known coverage gaps do not block
  completion: a channel the bot cannot view, read history in or (for voice) connect
  to, an archived-thread list Discord denies, or an unsupported channel type. They
  are listed in **Gap details** of `/archive status`, and the next pass takes a new,
  later cutoff and scans incrementally.
- **Partial** — a blocking failure: a source scan error, an inventory failure, a
  cancellation or pause, a Gateway gap during the scan, or a live inbox event
  observed at or before the cutoff that is still unprocessed. The next pass resumes
  the same run, cutoff and checkpoints; such a resume does not establish coverage
  through the current time.

Inbox events observed after the cutoff are reported as live backlog and never keep
a pass partial. Only passes that reach the end of the scan with blocking failures
count toward the resume limit; interruptions and unexpected errors do not. After
three such resumes the run is closed: the next run takes a new cutoff, rescans the
readable or unresolved sources the closed run left unfinished (fully, when the
closed run was a full reconciliation) and scans the others incrementally. Closing
a full run still requires another full pass when sources stayed unresolved or a
Gateway gap occurred since the run began.

Resuming a run never triggers a full pass by itself. A full run that completes,
resumed or not, reconciles every Gateway gap recorded before it began; a gap
observed after it began keeps the next run full, because sources completed by
earlier passes are not revisited. A completed [full backup](#full-backup) settles
the requirement the same way. Inspect the inbox backlog and the worker log when an
enabled schedule does not advance its cutoff. Each finished pass leaves a record in
**Recent records**.

### Restarts, Gateway gaps and channel changes

Each guild's `archive_gateway_continuity` record tracks whether live capture has
been lossless. Every Gateway event observed since its continuity start has been
captured; restarts, replaced sessions and Gateway gaps move that start forward.

- **Confirmation.** Every 30 seconds the worker confirms continuity through the
  oldest last acknowledged heartbeat of all shards, and only while the client and
  every shard are connected. Events still being written hold the confirmation back
  to their observation time. Nothing is confirmed after shutdown begins, because
  later events are no longer captured.
- **Restart or replaced session.** Events after the last confirmation may be
  missing after a restart, and also when Discord starts a new session for a shard
  instead of resuming the old one: a READY whose session differs from the shard's
  current one, which the worker learns when the bot becomes ready. A resumed
  session replays missed events and changes nothing. When the worker could not learn
  a shard's session at startup (it logs `Archive Gateway session seeding unavailable`),
  that shard's next READY may or may not replace a session: no rescan is planned, but
  the lossless capture window restarts then, so reaction lists refreshed earlier are
  reread instead of trusted. Each such break is recorded
  with its start. The next new run stays incremental but rescans every source from
  at least the earliest unsettled break start, minus a two-minute safety margin and
  the overlap window, even when the source watermark is newer; the run records the
  bound as `rescanFrom`. The margin and the overlap absorb clock skew and the delay
  between a dropped connection and its last acknowledged heartbeat, so keep
  `overlap_minutes` well above the heartbeat interval. Session replacement is
  frequent, so it is bounded like a restart rather than forcing a full
  reconciliation. A completed run settles every break recorded before it was
  created; breaks during the run stay pending for the next one. Edits and
  reactions made during the downtime to messages older than the bound are not
  recovered. A guild without a valid continuity record (first start, the first
  start after upgrading, or after a rebuild) begins with a full reconciliation.
- **Gateway gap.** Events may have been lost: a capture queue overflow (including
  events dropped before the guild was opened), a failed inbox write, a recorded
  gap event (written when a shard connection closes for good), or a dead letter
  without a source channel. The next new run is a full reconciliation. The
  requirement is written before the capture call returns, survives restarts, and
  clears only when a periodic full run or a full backup that began after the latest
  gap completes. If a gap was counted but its record was lost before a crash, the
  next boot detects it from the current periodic run or full backup and requires a
  full reconciliation. A guild whose gap cannot be recorded does not stop the others; the
  worker logs `Archive Gateway gap could not be recorded` with its guild ID.
- **Channel and thread changes.** Creating, updating or deleting a channel or thread
  updates its `archive_channels` record at once (name, type, parent and
  `everyoneCanView`, or `access: "deleted"`), adds no inbox event and needs no
  rescan by itself: every pass inventories channels and threads completely, scans a
  newly found source in full and a known source from its watermark. Discord delivers no events for a source the bot cannot
  read, so visibility changes are breaks for that source alone. When a channel
  event leaves the bot without View Channel or Read Message History on a source it
  could read, and when a pass finds a source readable again that was stored as
  denied, unknown or deleted, the next new run scans that source fully. Visibility
  changed only through the bot's roles emits no channel event: a source that turns
  unreadable and readable again between two passes this way is not rescanned fully.

Heavy live traffic alone is not a gap. The worker remembers recently changed
messages in a bounded table of 10 × `max_pending_events` entries. Evicting the
oldest entry only invalidates REST evidence read before that change, and the
affected source is retried; entries leave the table once their event is processed.

### Live capture inbox

Gateway events wait in the durable `archive_inbox` collection and are reduced in
observation order by each guild's own inbox loop, which a capture wakes and which
otherwise checks again every `job_poll_seconds`. History pages never wait for it; a
periodic pass or full backup waits for one round before it is planned and before
it judges completion. A failed round is logged
(`Archive inbox round failed; retrying`) and retried after one second, doubling up
to a minute.

- **Creations.** A complete MESSAGE_CREATE is stored without a REST read, with an
  empty reaction list complete as of its creation; later changes arrive as their
  own events. A creation without its author, or whose content the policy ignores,
  is read like an update, and so is a creation reduced after a later event of the
  same message was captured.
- **Updates and reactions.** Another snapshot or reaction event is reconciled with
  one REST read of the message. While the message's reaction lists are complete and
  not marked stale, an edit or a poll vote rereads no list and a reaction event
  rereads only the list of the reaction it names, of its normal or burst type (both
  types when the other has no complete list yet); a removed reaction's lists are
  dropped. A partial refresh keeps `reactionsFreshAt`. Lists never completely
  refreshed, refreshed before the current lossless capture window began, or already
  marked stale, an event that names no reaction, several changes of one message
  reduced together, and counts of other reactions that differ from the stored ones
  reread every list.
- **Unknown messages.** A reaction or poll vote on a message the archive does not
  hold, or holds only as an interaction record, is acknowledged without a read;
  history scans cover messages not yet stored. While an older snapshot event of that
  message is still waiting (a creation whose reduction failed), the reaction event
  waits for it instead, uncounted, until that event's next attempt.

A failed
reconciliation is routed by cause, including the Discord error behind a failed
reaction refresh:

| Cause                                                                      | Result                                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Unknown Message (10008)                                                    | The message is tombstoned; the event is done                              |
| Unknown Channel (10003)                                                    | The source is recorded as deleted; the event is done                      |
| Missing Access (50001), Missing Permissions (50013) or another Discord 403 | The source is recorded as a denied coverage gap; the event is done        |
| A newer event for the same message was captured or is still queued         | The newer event reconciles the message; this one is done, uncounted       |
| Storage headroom or in-process queue pressure                              | Retried after five minutes, uncounted                                     |
| Discord 5xx or 429, a timeout, a dropped connection or a database outage   | Retried uncounted, waiting about as long as it has failed (1 min to 1 h)  |
| Anything else, including a 403 without a Discord error code                | Counted; retried after 1, 2, 4 … minutes (at most one hour between tries) |

If a coverage gap cannot be recorded, the event is retried as a counted failure.
An event becomes a dead letter when its counted attempts exceed 10 (about five
hours), when transient failures continue for 24 hours after its first failure,
when it is claimed 50 times in a row without any recorded outcome (a crash, an
expired lease or a programming error while applying it), or when it is too large to
load or does not match its contract.

Dead letters keep their last error, are never retried and no longer count as
pending: they neither keep a pass partial nor appear in the live backlog. The
change they carried may be missing, so the next new periodic run rescans their
channels fully and lists each as the known gap
`<channelId>: live-event-dead-lettered`; its result counts them as `deadLetters`.
`/archive status` shows the current number as abandoned events. When it is above zero, search the worker log for
`Archive inbox event dead-lettered` and inspect the `archive_inbox` documents with
`state: "dead"`. A TTL index deletes dead letters 30 days after `deadAt`; until
then they count toward `max_inbox_bytes`. Pending events observed at or before a
pass cutoff keep the pass partial; later ones are reported as live backlog.

For initial setup, run a [full backup](#full-backup), then enable the schedule.
Follow the [control setup](#discord-controls) to register the command after deployment.

## Backup throughput

History consumers write a whole page per writer turn, up to 500 independent
messages and 4 MiB, in bounded, verified batches; each message, including its edit
history, is one write. Stored images too large for one turn halve it, and oversized
documents fall back to one message. A re-observation that changes only backup
metadata (`observedAt`, `reactionsFreshAt`, `reactionsStaleAt`,
`reactionGenerations`) updates those fields under the same full-image fence instead
of rewriting the document. Fresh empty reaction observations are published
atomically with the snapshot, which clears old membership references without a
second write.

Nonempty lists require Discord membership reads. The same snapshot write marks such
a message's lists stale; the refresh stages its membership chunks in one insert
(more only beyond 500 chunks or 2 MiB) and publishes every list, the freshness and
the cleared mark in one write. `reactionsFreshAt` is when the refresh's membership
reads began: every change before it is in the lists.

An incremental periodic pass keeps a message's published lists without rereading
them when Gateway capture proves them current: the page reports the same reactions
with the same normal and burst counts, every list is published complete and not
marked stale, `reactionsFreshAt` is not earlier than the start of the current
lossless capture window (see [restarts and Gateway gaps](#restarts-gateway-gaps-and-channel-changes)),
and the message has no live change still being reduced or read since the page was
read. Such messages count as completed. Full backups, full reconciliations and
sources whose live events may be missing (a visibility change or a dead letter,
including a visibility break recorded while a run resumes) reread every list. See the [measured comparisons](contributing/archive-performance-results.md#throughput-hardening-2026-10-11).

A source counts as completed only after its entire bounded history is acknowledged.
Several large sources can therefore show scanned messages while completed sources
remains zero. Counters separate inserted messages, content updates, unchanged
content and policy exclusions; the panels show inserted and updated messages
together as written. Writes made before an interrupted page was checkpointed are
replayed on resume and may count as unchanged.

Increasing concurrency does not repair an unindexed database query or bypass
Discord quotas. Membership requests, permissions and live inbox work still affect
duration. Use source checkpoints and inbox age alongside totals; synthetic query
speedups are not a prediction of end-to-end backup duration.

`Archive pipeline performance` is logged at most once per 30 seconds on saved
checkpoints, and the same fields close `Archive worker performance` at shutdown.
Values are cumulative since the worker started, and no field nests deeper than the
log scrubber's limit (`stages.fetch.count`):

- `pipeline`: the 128 MiB staging budget, reserved and waiting per lane
  (`historyReservedBytes`, `reactionReservedBytes`, `historyWaiting`,
  `reactionWaiting`), its peak and total `queueWaitMs`. A history read reserves its
  8 MiB maximum until it returns, so at most fourteen are in flight. A reaction read
  reserves a 256 KiB page estimate and grows it if the response is larger, so the
  16 MiB reaction lane admits 64 reads at once.
- `stages`: `count`, `durationMs` and `bytes` for `fetch`, `normalize`
  (normalization), `write` (full-page writes), `reactions` (membership refresh),
  `checkpoint` and `process` (consuming a page). Timings overlap, so do not sum
  stages as wall time.
- `scheduler`: requests running and queued for admission, and channel routes held by an
  announced wait.
- `rateLimits`: 429 responses by Discord scope (`global429`, `route429`,
  `shared429`, `unknown429`), SDK rate-limit waits (`waitEvents`, `waitMs`, split into
  `globalWaitMs` and `routeWaitMs`) and `invalidLast10Minutes`, the 401, 403 and
  non-shared 429 responses that count toward Discord's invalid-request limit.

`@discordjs/rest` runs every reaction read of a channel one after another, so a
message refreshes at most two lists at once (one overlaps staging with the other's
read), and parallel reaction reads come from other channels being read. Raise
`archive_runtime.concurrency` only while `scheduler.queued` grows and the pipeline
lanes have room. Persistent `reactionWaiting` means the reaction lane, not the reader
count, limits throughput; growing `globalWaitMs` or `global429` means Discord's limit
does.

## Progress

Runs use a fixed cutoff and durable checkpoints. Newer messages belong to live
capture or a later pass. Reads share the SDK's rate limiter, use bounded concurrency
and reserve capacity for live work.

Progress uses a shared versioned model, saved with the full-backup job
(`result.progress`) or the periodic run (`archive_periodic_runs`). A stored snapshot
is read through its versioned schema: older versions are upgraded, and one of an
unknown version or without a known phase and state is ignored. Activity lines show
real fetches, message batches, reaction pages and checkpoints; there is no simulated
movement, so a slow request can keep the same activity until it returns. Recent
speed uses only newly acknowledged history pages in this process, with at least two
samples one second apart within a 60-second window, and disappears after 30 seconds
without a new checkpoint; restored counts never inflate it. The reaction count is
messages whose nonempty lists were completed or kept as current, not people or a
percentage. Unknown
totals stay unknown. Raw errors, message bodies, membership lists and temporary
attachment URLs are not panel data; a failed backup shows a reason category and the
worker log holds the error.

`progress_interval_seconds` is fixed at `10`. The full-backup panel refreshes on that
heartbeat even when no counter changes; state changes and final results publish at
once. Edits of one panel are serialized between the worker and button handlers and
coalesced; a failed edit is retried without posting duplicates, and a failed final
result is retried on later polls, backing off from five seconds to five minutes.
Discord rate limits or outages can delay delivery. Notification failures never
change the durable outcome: the worker saves the job's final state before showing
it.

## Activity reports

`/traffic` reads the archive through the read-only statistics reader, so any bot can
enable it; only msg-archive writes. Every subcommand defers its reply and sends one
embed: a title naming the report and its range (for example "<server> · Server
activity · Last 7 days") and a dashboard image in two columns. Discord fits an embed
image into a box of about 4:3, so the dashboards are laid out near 4:3 for the largest
displayed text: the activity and app dashboards fill exactly 4:3 (a taller trend uses
any spare height), and the emoji and sticker dashboards are a little wider, where
extra height would only add empty space. `overview` and `channel` also list the top 3
messages in the embed text, under a bold heading; Discord shows that text above the
image. The reply has no summary line and no footer.

| Subcommand                                    | Shows                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `overview`                                    | Messages with the change against the previous period, daily average, active members and channels, retention, returning and new members, top member share, busiest day, trend, interactions, content types, member and channel rankings, weekday × hour heat map, and the top 3 messages in the embed text |
| `channel channel:<channel> [include_threads]` | The same for one channel (text, announcement, forum, media, voice or stage chat, or a thread), with the threads under it by default; the right ranking lists the channel and its threads, or weekday averages when there are none                                                                         |
| `me`, `user user:<member>`                    | One member: rank, share of visible traffic, active days and longest streak, reactions received and given, commands used, mentions and replies, content, conversation partners, channel distribution and a personal heat map                                                                               |
| `apps [app]`                                  | Interactions per application split into commands, components and modals, the trend, and the most active members; `app` drills into one bot                                                                                                                                                                |
| `emoji [order] [kind] [source]`               | Use of the guild's current custom emoji in text and reactions, matched by ID, with unused emoji listed                                                                                                                                                                                                    |
| `sticker [order]`                             | Use of the guild's current stickers, matched by ID, with unused stickers listed                                                                                                                                                                                                                           |

Shared options: `range` (`24h`, `7d`, `30d`, `90d`, `365d`; default `7d`, `30d` for
emoji and stickers), `visibility` (`public` by default, or `ephemeral`), and `top_n`
(at most the rows a dashboard draws: 5 for member, channel and app rankings, where
`top_n` sizes the app ranking of `apps` and its member ranking stays a top 5; 20 for
emoji, 12 for stickers). `24h`
is a rolling window; the other ranges are whole local days ending today, so `7d`
shows seven daily points with today last, compared with the same span one range
earlier.
Trends are hourly for `24h`, weekly for `365d` and daily otherwise; trends, heat
maps and day labels use the bot host's time zone. `24h` omits the heat map; the two
rankings then stack instead of sitting side by side. A member
runs one report at a time, and a server runs one `90d` or `365d` report at a time;
a request beyond that gets a private "busy" reply.

Counting rules: a message counts at its `createdTimestamp`; deleted messages still
count, but no reply shows a deleted count; bot and webhook messages and system
messages do not count (only types 0 and 19), except interaction records for `apps`.
Threads under a text or announcement channel count toward that channel; forum and
media posts stand alone. Names use the live guild name, then the last stored name.

Visibility follows the [privacy rules](architecture.md#privacy-aware-data-commands)
for every subcommand except `emoji` and `sticker`, which count every channel and show
no channel. `/traffic user` is filtered by the invoker, not the member shown. A
`public` reply counts only channels that every role able to read the command channel
can also read, and never private threads. `/traffic channel` answers a channel the
invoker may not count, including one a `public` reply excludes, with "not found or
no permission". Message previews name only channels the reply may count. Only the
report follows `visibility`: a busy refusal, a notice such as "no data" or "not
found", and an error always reach only the invoker, even for a `public` report.

The top messages are the three live member messages with the most reactions. Each
preview shows at most 30 characters of the current text with markdown and masked
links escaped, mentions and custom emoji as plain names, spoilers hidden, and a
placeholder such as "(2 images)" for a message without text; the jump link is in the
embed text.

Data limits, not repeated in the replies: reaction counts are the last observed
values; command use covers only interactions that left a public reply and has no data
before the rebuilt archive; until the first full backup completes, the activity
reports (`overview`, `channel`, `me`, `user`) are incomplete. A query over 60 seconds
stops and asks for a smaller range. Custom emoji, sticker and bot
pictures come from the Discord CDN with a five-second timeout and a placeholder when
a download fails; Unicode emoji use the colour emoji font.

## Capacity and recovery

The 100GB budget includes runtime, database/indexes, logs and existing attachments.
Configure additional storage roots in
[capacity settings](configuration.md#archive-runtime).

Space pressure pauses background work before live capture. A hard limit can stop
capture; unknown capacity blocks writes. Neither condition authorizes deleting
edit history or truncating reaction lists.

Stop the previous worker before replacement. Startup refuses takeover unless the
old owner and its database operations are proven stopped. Resolve the diagnostic;
do not delete an active lease.

## Full backup

A full backup is one job in `archive_jobs` (`command: "full-backup"`). Confirmation
fixes its cutoff (`options.cutoff`); newer messages belong to live capture and later
periodic passes. The worker runs it as its own full scan of every readable channel
up to that cutoff, with complete reaction memberships, and records per-channel
checkpoints separately from periodic ones, so neither kind resets the other.

- **One at a time.** A guild has at most one queued or running full backup. A queued
  full backup preempts a periodic pass at its next safe boundary, and periodic passes
  wait until the backup ends; live capture continues throughout.
- **Stop and resume.** **Stop** is cooperative: the current page reaches a safe
  boundary, checkpoints and archived messages stay, and the backup ends **Stopped**.
  **Resume** queues the same job again with its original cutoff and checkpoints.
  Only the newest full backup can resume; starting over creates a new job and leaves
  the old one as a final record.
- **Restarts.** A backup interrupted by a restart or deployment is queued again when
  the worker starts and continues from its checkpoints with the same cutoff. A stop
  requested before the restart ends it **Stopped** instead. A guild in capture-only
  mode (its message indexes need maintenance) ends a claimed backup **Failed** with
  `structural-maintenance-required` instead of scanning.
- **Completion.** Known gaps (channels the bot cannot read, unsupported types) do not
  block completion: the job ends `complete` and lists them in `result.gaps`. The
  result records the cutoff, scanned and written counts, the gaps and the messages
  whose reaction lists stayed incomplete. Blocking failures (a channel scan error, a
  storage pause, a Gateway gap during the scan, live events before the cutoff still
  unwritten) end it **Failed** with a reason category; resume after fixing the cause.
  A storage pause is never treated as a stop.
- **Reactions.** When one message's reaction list cannot be confirmed for a reason
  of its own (it keeps changing, stays incomplete, or the message is gone), only that
  message is marked stale, keeping its previous complete list, and the page still
  checkpoints. A later reaction event or a scan that covers the message refreshes
  it. Failures that would affect every message alike (Discord 5xx or rate limits,
  timeouts, dropped connections, database outages, a lost channel or permission,
  storage pressure) fail the page instead, so it is retried. Periodic passes use the
  same rule.
- **Gateway coverage.** A completed full backup settles continuity like a complete
  full periodic run, against the state when it first started: it clears the
  full-reconciliation requirement only if no Gateway gap occurred since then, and
  settles the restart and visibility breaks recorded before then. Breaks during the
  backup, including a restart that interrupted it, stay pending for the next
  periodic run.
- **Result writes.** The worker retries a failed final write four times, waiting 1,
  2, 4 and 8 seconds (shutdown ends the wait), then logs
  `Archive job result could not be saved`. It keeps the unsaved result in memory and
  retries it on later polls, backing off up to five minutes, before claiming any
  other work; periodic passes stay paused meanwhile. A restart before it succeeds
  queues the backup again instead.
- **Result display.** A failed edit of the final panel is retried on later polls,
  backing off from five seconds to five minutes, for at most twenty attempts. A panel
  Discord refuses permanently (deleted message or channel, lost access) is detached
  at once; the result stays in `/archive status`.

Stopping does not undo written messages. A full backup does not enable the periodic
schedule; enable it afterwards with `/archive schedule enabled:true`.

Developer throughput measurements use the isolated
[archive benchmark](../tools/archive-benchmark/README.md). Synthetic local results
do not establish production throughput or authorize a production scan.

Production execution requires operational review; local tests do not establish
production capacity, permissions or throughput. See [deployment](contributing/deployment.md#message-archive-worker-upgrades),
[Discord controls](#discord-controls).
