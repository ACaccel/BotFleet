# Message archive

`msg-archive` owns message capture, backup and repair writes. Other bots may read
archived messages; their existing attachment caches and deleted-file archives
continue independently. Operators manage archive work through `/archive` in
Discord; msg-archive remains the only archive writer.

## Scope and retention

`backup_server` selects guilds. Discovery covers text/announcement channels,
voice/stage chat, active and archived threads, and forum/media posts. Previously
known locations are rechecked. Missing permissions, unsupported types and
incomplete private-thread discovery remain coverage gaps, never empty history.

Humans are included. Bot and webhook allowlists are separate and default to
empty. Unknown authors are retained for classification; policy changes do not
automatically delete existing records.

| Content                 | Retained data                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| Messages                | Latest text, author/source IDs, timestamps, readable embeds, mentions, reply and thread relationships |
| Edits and deletions     | All observed content versions and deletion markers                                                    |
| Attachments             | Identity, source URLs, size, type and dimensions; no new file downloads                               |
| Reactions               | Complete normal and burst (Super Reaction) user lists, with freshness status                          |
| Stickers and polls      | Sticker ID/name/format; poll question, options and result counts, without voter lists                 |
| Components and forwards | Readable labels, choices and links; one level of forwarded snapshot content                           |

Raw API payloads, interaction tokens, avatars, voice waveforms and per-event
reaction histories are excluded. Partial updates preserve unobserved fields;
replay and URL refresh do not create artificial edit versions. Incomplete reaction
refreshes preserve the previous complete membership.

Deleted messages never captured and unobserved historical edits cannot be
recovered. Attachment URLs may expire; metadata does not guarantee access after
the source is deleted. See [configuration](configuration.md#message-archive) and
the [normalization contract](../src/core/archive/normalize.ts).

## Discord controls

Register `/archive` on msg-archive after adding `archive` to its local `commands`:
`npm run register -- -t msg-archive`. Deployment and command registration remain
host operations. Reviewed repair, timestamp conversion, automatic verification,
progress and recovery use the following Discord workflow.

| Entry                 | Purpose                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `/archive backup`     | Create a plan, review changes and confirm the one-shot backup                              |
| `/archive jobs`       | Select a job to view progress, stop, resume through its plan, or delete its record         |
| `/archive plans`      | Select a plan to review its summary/changes, execute it, or delete an eligible unused plan |
| `/archive schedule …` | View or adjust periodic backup independently of one-shot work                              |

Archive pages use buttons only, with at most five controls per page. Job and plan
lists show two numbered entries with status and creation time, matching item
buttons, **Refresh**, **Next page** when applicable, and **Delete all jobs** or
**Delete all plans** when the list is nonempty. Jobs include finished records. Active-only filters and
**More actions** are removed from new pages. Selection and pagination update the existing public message.
Item panels open apply, resume or acceptance confirmation directly when eligible;
**View details** opens the compact changes view. Routine views omit internal IDs
and hashes. Long legacy identities use bounded temporary references internally;
reopen the list if a reference expires.

The job page offers **Stop job** while active and **Delete job record** after the
job stops. There is no combined stop-and-delete button. Stopping is cooperative:
in-flight work reaches a safe boundary before the status becomes terminal; a
queued job can stop immediately. Deletion requires confirmation and preserves
archived messages, checkpoints and repair recovery data. Approval receipts prevent
old buttons from recreating deleted work.

**Delete plan** is a direct button and requires confirmation. A plan is eligible
only without active consumers or jobs and without a recovery journal, and when
either of these conditions holds:

- It has never been applied: its state is `planned`, `partial-plan` or
  `failed-plan`, and every operation is still `planned`.
- It has completed rollback: its state is `rolled-back`, every operation is
  `rolled-back` or `planned` (never mutated), and no records remain in
  `archive_repair_conflicts`.

Plans that are still rolling back, have rollback conflicts, are partly applied
or retain other applied changes remain protected. The backend rechecks eligibility
atomically against submission and deletion reservations. Successful deletion
removes only the plan and its operation/control metadata; archived messages are
preserved. Related old notification publishers are superseded.

Single-item delete confirmations are bound to the requesting manager, guild, channel and
message, expire after five minutes and become invalid after restart. Deletion
intents already accepted by the backend are durable. Job/plan deletion does not
change automatic backup scheduling or live capture.

There is no advanced page. Audit, standalone verification and attachment refresh
have no UI entry points; backend support remains for legacy work. Apply verifies
automatically, and acceptance performs a fresh check. Eligible rollback appears
as a direct button. A queued job has not completed: wait for the outcome and
review partial coverage. Reports contain safe impacts and counts, not message
bodies, raw records, credentials or signed attachment URLs.

### Bulk deletion

Use **Delete all jobs** or **Delete all plans** on the corresponding list to
review every page in the current guild. The review shows the total, eligible and
protected counts, includes finished jobs, and identifies queued or running work.
Opening the review does not delete anything. **Confirm bulk deletion** is available
only when at least one item is eligible. The requesting manager must confirm in
the same channel and message within five minutes.

Confirmation processes only the identities captured in that review; later arrivals
are excluded. Each item is checked again before deletion. Job cleanup deletes
job records only: running work receives a cooperative stop-and-delete request and
its record is removed after the worker drains. Archived messages, backup progress,
plans, recovery data and schedules remain. Plan cleanup uses the same
[eligibility rules](#discord-controls) as single-plan deletion: unused,
never-applied or fully rolled-back plans without conflicts or recovery journals
can be removed. It deletes only plan and operation/control metadata, preserving
archived messages. Plans with remaining applied changes or active work remain
protected.

The public cleanup card refreshes every ten seconds and separates deleted records,
submitted stop-and-delete requests, protected items, failures and unprocessed items.
Submitted requests finish automatically after their workers stop; check the jobs
list for the final result. Durable result/resume controls preserve the original
snapshot through interruption and restart. Resume requires proof that the prior
executor has stopped; it cannot include new items or protected repair data. For failed
items, return to the list and review a new batch. Old select-menu interactions
remain compatible, but their refreshed pages use buttons. Final plan deletion
notices replace recognizable status cards only; a panel browsing another item or
bulk cleanup remains unchanged. Legacy standalone notices without a status marker
may remain stale; reopen the plans list to check the current state.

### Access and confirmations

All `/archive` routes, buttons and legacy menus are served only by msg-archive.
The guild must be listed in `backup_server`, and the operator must be its owner
or hold Manage Server permission. Run commands in the configured
`guilds.<guildId>.channels.debug` channel. The bot must be able to view that channel,
send messages and embed links. Access failures do not modify the shared progress
message or create jobs. Authorized status, results, inspection and confirmation
views use public messages in this debug channel; they do not open private status
panels. Button navigation updates the message containing the clicked button,
never another item's original notification. Navigation checks current permissions
on every action. On the item's original notification, its live status stays above
the detail page. A list panel instead shows the selected item's self-contained
summary and actions without retaining another job's status. Any authorized operator
can change the same public panel; separate panels keep independent browsing state.
mutating confirmations remain bound to the operator who requested them.
Shared views expose only safe metadata, not raw recovery images.

Apply, resume, accept and rollback show a confirmation button. Only the operator
who requested it can confirm, in the same guild, debug channel and displayed panel.
New approval records persist that panel binding separately from the job's original
notification; legacy approvals resolve their original notification. Confirmation
checks access, configuration and current run state again. Confirmation requests
persist across process restarts and expire after five minutes. Retrying or clicking
twice cannot create duplicate jobs. An expired confirmation requires a new request.
Planning never silently applies a repair. Removed diagnostic UI entry points do
not change authorization or validation for legacy backend work.

## Periodic schedule

Periodic history scans default to disabled, including existing installations
without saved settings. Gateway capture and one-shot control jobs remain active.
Settings live in each guild's `archive_schedule` collection and survive restarts.
Use `/archive schedule` in the configured debug channel under the same
[access rules](#access-and-confirmations) as every archive command.

| Command                                      | Behavior                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `/archive schedule status [page:<n>]`        | Show schedule/progress, optionally with a page of source and gap details                       |
| `/archive schedule enable [minutes:<value>]` | Set an optional interval and enable backup in one step; retain the saved interval when omitted |
| `/archive schedule disable`                  | Stop new passes; pause a running periodic scan at a safe boundary                              |
| `/archive schedule interval minutes:<value>` | Set 1–10080 minutes; does not enable a disabled schedule                                       |

The interval normally starts after a pass finishes. Changing it schedules the
next pass from the change time; the current pass is not restarted or overlapped.
Repeated enable/disable commands or an unchanged interval leave the next-run time
and current pass unchanged. For example, `/archive schedule enable minutes:60`
sets an hourly interval and enables the schedule atomically. Setting `interval`
alone never enables a disabled schedule. Command results explain when the change
takes effect and whether the schedule remains disabled.
A disabled running pass preserves checkpoints; enabling resumes that pass before
starting a fresh one. In-flight requests may finish before a pause is observed.
Schedule changes never cancel a one-shot repair or live capture.

For initial setup, finish and accept the one-shot repair, then enable the schedule.
Follow the [control setup](#discord-controls) to register the command after deployment.

## Progress and access

Runs use a fixed creation cutoff and durable checkpoints. Newer messages belong
to live capture or a later pass. Reads share the SDK's rate limiter, use bounded
concurrency and reserve capacity for live work.

Progress uses a shared versioned model and a compact public embed. The title
identifies the current state and phase. One **Current activity** line shows the
latest active source, a short processing step and available page or staged reaction
membership counts. Waiting sources do not hide other sources making progress.
Reaction membership counts describe entries staged for the current message, not
distinct people or a completed reaction generation. New history fetches clear old
page counters; resumed requests clear old wait details. Terminal cards omit the
activity line. Other bullets retain relevant acknowledged counters. Routine views
omit the full phase sequence, duplicate persistence counters and empty reaction rows.
Unknown counts, incomplete writes, coverage gaps and the next operator action remain
visible. A queued plan explicitly says history backup starts only after confirmation.
Source labels are disclosed only when cached
permissions establish public readability; restricted, private-thread or unresolved
sources use safe identity fallbacks. Raw errors, message bodies, membership lists
and temporary attachment URLs are not public status data. Audit/plan count inspected
records and candidates; apply/resume distinguish completed repair operations from
scanned messages. Unknown totals remain unknown. Stage completion does not imply
that the whole backup is complete. Routine views omit internal IDs, hashes and
verbose diagnostics; source IDs may identify affected locations when meaningful.

A partial or failed one-shot job has stopped; its notification is a final result,
not a stalled live counter. Completed repair operations are distinct from scanned
messages: zero scanned messages does not mean that no repair writes occurred.
Open the public problem view to review the problem and, when offered, resume the original
run after resolving its cause. Completed writes remain recorded; do not create a
replacement plan just because a terminal notification no longer changes. A stopped
periodic scan may be retried by the enabled schedule.

On a job's original notification, its status embed remains visible while the same
message's detail area shows problems or compact changes. Public progress offers
**View details** and **Stop job** when available. Timer updates preserve the selected
page, including a displayed confirmation and its action button. Selecting an item
from a list opens its summary and actions in that list's message; running-job
summaries offer **Refresh**, and list navigation remains in the same panel.
Explicit navigation replaces that view; an eligible primary action opens a fresh
scoped confirmation directly. If a notification is repurposed to browse another
item or list, its former job's heartbeat and deletion publisher leave that panel
alone. Explicitly reopening its original item restores the live status.
An undisplayed terminal result remains available in `/archive jobs`; skipping a
repurposed panel does not mark that result as delivered. Deletion notices instead
record that their old display was superseded, so they cannot reclaim the panel.
Open a job from `/archive jobs`, or use `/archive schedule status page:1` for
periodic activity and issue details. Change inspection has no category, source or
individual-operation drilldown. Names are escaped
and mentions disabled. Detail text is bounded to 1,900 characters and the combined
embed payload stays within Discord limits. Slash status requests reuse the saved
public message; button navigation stays in its originating panel. A genuinely
deleted notification can be recreated.

`progress_interval_seconds` is fixed at `10` for periodic and one-shot work.
An event-independent heartbeat refreshes the message even when no counters change;
state transitions and terminal results publish immediately. The card records its
update time and elapsed work time. Activity changes come from actual fetches,
message batches, staged reaction pages and maintenance checks; there is no simulated
movement. A slow request can therefore keep the same activity until it returns.
Updates to the same message are serialized and
coalesced; delivery failures retry without posting duplicates. Discord rate limits
or outages can delay delivery, so the timestamp reflects the last delivered card,
not a promise that a stalled connection can update every ten seconds. Terminal
work stops its timer. Saved message references survive restart; notification
failures never change the durable outcome. REST telemetry distinguishes actual
HTTP responses from SDK waits, not all traffic on a shared IP.

Use `/archive schedule status` for daily-backup status and `/archive jobs`
for one-shot work. Job outcomes and worker checkpoints are persisted in MongoDB;
notification failures and expired Discord interactions do not stop the worker.
Review partial results and coverage gaps before acceptance.

Claimed-job setup and execution share the same failure boundary. Progress
publication is best effort: a failed progress snapshot or Discord edit does not
change the repair result. The worker persists the terminal job result before
publishing it, so a notification failure cannot turn completed work into a failed
job. A terminal database write failure remains an execution error requiring
recovery; it is not reported as successful notification delivery.

`/db_list_message` requires current source access. Exports are private; public
printing is allowed only in that source channel. `refresh-attachment` checks
source access before refreshing a temporary URL.

## Capacity and recovery

The 100GB budget includes runtime, database/indexes, logs, existing attachments
and repair recovery data. Configure additional storage roots in
[capacity settings](configuration.md#message-archive).

Space pressure pauses background work before live capture. A hard limit can stop
capture; unknown capacity blocks writes. Neither condition authorizes deleting
edit history or truncating reaction lists.

Stop the previous worker before replacement. Startup refuses takeover unless the
old owner and its database operations are proven stopped. Resolve the diagnostic;
do not delete an active lease.

## One-shot repair

1. Run `/archive backup` to create a plan. When it finishes, review the change summary
   in its public debug-channel message. Planning
   alone does not fetch or save Discord history.
2. Choose **Confirm and start backup**. The worker applies the reviewed changes,
   fetches history and complete reaction memberships up to the fixed cutoff,
   then verifies the result automatically. Follow the same durable progress
   message; reopen its panel whenever the original interaction expires.
3. Review the completed result and choose **Accept result** on its panel.
   This opens the current confirmation scope and expiry together with
   its confirmation button. Job management also offers cooperative stopping and confirmed
   record deletion. Acceptance verifies
   again and starts the **72-hour recovery-data retention period**. A partial,
   failed, cancelled or unverified run cannot be accepted through this flow.

This flow does not enable the periodic schedule. Read the change categories and
any deletion, quarantine or policy-exclusion impact before confirmation. Detailed
changes remain available through **View details**. A missing summary
is shown as unavailable, never as zero changes or proof that the run is safe.

### Review and recovery

Use `/archive jobs` or `/archive plans` to recover durable context when the
original notification is unavailable. Select the item and use its primary action
or its available action buttons. A run identifies the repair workflow; each submitted stage has
its own job. Resume continues an eligible run with the existing cutoff and journal;
rollback requests conditional recovery and reports conflicts. Stopping or deleting
a job never automatically reverses committed writes.

Apply verifies its result automatically. Acceptance still performs fresh validation
and requires explicit confirmation; neither step opens a separate diagnostic page.

Plan inspection starts with a readable summary of the entire manifest. Its change view
identifies the affected source and record type, explains the action and impact,
and labels execution state separately. Resetting a source's progress clears its
resume position; deleting duplicate progress removes redundant progress records.
Neither action deletes the Discord source or its archived messages. Other repair
actions may change or remove archived message records and remain explicitly
identified in the summary and change list.

**View details** opens one changes view. Plans with at most ten changes show
concrete rows, at most five per page, with shorter pages when needed to fit.
Larger plans show grouped action, record type and mutation impact, including
mixed execution states and source examples. Examples are previews, not an
exhaustive list. There are no category, source or individual-operation drilldowns,
technical pages or downloads. Current cached names enrich source identities when
available; historical names are labeled, and an unresolved name never implies
that a channel was deleted. A known source ID and a currently resolvable name are
different facts: the summary counts unknown identities separately and explicitly
marks unavailable whole-plan current-name coverage instead of inferring it from
the displayed page.

Browsing edits the same public message instead of posting each page separately.
Successor jobs for the same run reuse its durable message; superseded jobs cannot
overwrite the new status. Independent backup runs retain separate messages.
Old detail buttons redirect to the compact changes view. Internal IDs, hashes,
dependencies and raw recovery images remain backend data rather than routine UI
fields. Message content and signed attachment URLs are excluded from these reports.

Backend `after_sequence`/`limit` options retain the legacy exclusive-cursor behavior;
`-1` starts at the beginning and the next page starts after the last shown
sequence. The limit affects display only, never the apply scope.

A plan fixes its source policy, schema identity, capacity estimate and scan cutoff.
Its initial validity is 24 hours; stale plans require replanning. Resume keeps the
existing journal and upper bound and rejects changed policy/schema settings.
Numeric timestamp strings are repaired in this reviewed workflow rather than a
separate terminal migration. The worker validates canonical identities and builds
the unique message index before normal ingestion or enrichment resumes.

Repair saves prior values before changes. Conditional rollback preserves later
updates and reports conflicts, including related reaction data. Observed edit
versions remain permanent even after rollback. Missing indexes may require
structural repair before normal writes resume.

Rollback delete/replace predicates combine native `_id` equality with the complete
current-document comparison. The ID predicate uses MongoDB's existing index;
the full-image guard still rejects a write that races with recovery. Omitting the
ID predicate caused a collection scan for each conditional write, so even a small
rollback could repeatedly examine millions of documents. Recovery remains in
reverse journal order; unrelated operations are not globally parallelized.

Recovery data remains for **72 hours after acceptance**. Failed, partial,
unaccepted and actively rolling-back runs do not expire on age alone. Recovery
supports logical rollback, not physical disk failure.

Repair cancellation is checked at scan and mutation boundaries with a per-job
250ms polling cache. Shutdown also supplies a local abort signal. An already
issued database operation must reach its safe journal/checkpoint boundary;
cancellation does not undo committed writes. Audit and fresh verification also
check cancellation while scanning. This is a polling bound, not a guarantee
that a remote operation finishes within 250ms.
History batches and reaction membership pages also check stop/pause requests;
incomplete pages never advance their durable checkpoint. A reaction-heavy message
does not require waiting for its entire membership list before pausing.

Developer throughput measurements use the isolated
[archive benchmark](../tools/archive-benchmark/README.md). Synthetic local results
do not establish production throughput or authorize a production scan.

Production execution requires operational review; local tests do not establish
production capacity, permissions or throughput. See [deployment](contributing/deployment.md#message-archive-worker-upgrades),
[Discord controls](#discord-controls).
