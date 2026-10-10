# Architecture

Each personality runs in its own process. Its composition root selects plugins and
connects shared services to Discord, MongoDB and external providers. See
[Contributing](../CONTRIBUTING.md) and [Configuration](configuration.md).

## Layers and boundaries

| Layer                              | Responsibility                                             |
| ---------------------------------- | ---------------------------------------------------------- |
| [core](../src/core/)               | Contracts, errors, Result, i18n, IoC, logging and policies |
| [persistence](../src/persistence/) | Repository contracts and Mongoose storage                  |
| [infra](../src/infra/)             | Discord, MongoDB, HTTP and provider adapters               |
| [handlers](../src/handlers/)       | Commands and interaction entry points                      |
| [plugins](../src/plugins/)         | Features, subscriptions and scheduled jobs                 |
| [bot](../src/bot/)                 | Composition roots, service tokens and lifecycle            |

ESLint enforces boundaries: core cannot depend on application layers; handlers
and plugins cannot import each other. Plugins use context instead of importing IoC
or personality roots; [tokens](../src/bot/tokens.ts) and
[guild lookup](../src/bot/guild-registry.ts) are explicit contract exceptions.
Shared Discord helpers belong in infra. `src/` cannot import `scripts/`; `tools/` owns operator workflows.

## Startup and shutdown

Bootstrap validates configuration; [BaseBot](../src/bot/index.ts) builds services
and initializes plugins before login. Listeners attach before guild registration,
repository connection and ready hooks. Guild database failures are isolated and can recover.

Startup rejection exits with failure. Shutdown cleans up resources within a deadline;
a second signal exits immediately. Discord handles reconnection. Uncaught exceptions
use a narrow transient-network whitelist, separate from ordinary retry policy.

`BOTFLEET_READY_FILE` attests startup readiness of Discord, repositories and plugins;
disabled plugins prevent publication. See [deployment](contributing/deployment.md)
for this startup marker, which does not indicate continuous health.

## Plugins and dependency injection

The typed [ServiceContainer](../src/core/ioc/) binds singleton services with
`ServiceToken<T>`. Factories and registries hold per-guild state. Handlers use BaseBot
accessors; plugins resolve the same instances through context.

| Hook                   | Responsibility                                                    |
| ---------------------- | ----------------------------------------------------------------- |
| `init`                 | Initialize services; only phase permitting `ctx.registerInstance` |
| `start`                | Attach listeners and start background work                        |
| `onReady`              | Work requiring registered guilds and Discord readiness            |
| `onGuildDatabaseReady` | Restore the recovered guild's database-dependent jobs             |
| `onShutdown`           | Release resources in reverse registration order                   |

Factories validate plugin configuration. Hook failures disable that plugin while
the host continues; shutdown also cleans up disabled plugins. Generated registries
own handler registration. See [Adding a plugin](contributing/adding-a-plugin.md).

## Interaction request flow

```text
Discord event -> ClientEventBridge -> InteractionRouter + middleware
              -> generated registry -> handler -> service / repository / adapter
```

Components route by the leading custom-ID segment; reaction handlers inspect
reactions themselves. `npm run handlers:gen` maintains registries, checked by CI.
The router translates domain failures into ephemeral replies; failed autocomplete
returns no suggestions. Shared Discord utilities live in `infra/discord`.

## Temporary moderation and automatic replies

Persistent [thread moderation](thread-moderation.md#implementation-contract) runs
in `ClientEventBridge` before concurrent plugin dispatch, interaction routing and
reaction handlers. It is opt-in per bot and enabled in Nijika's configuration.
Its repository isolates restrictions by guild, bot and thread.
Delegated authority and recipient-bound DM review decisions share the thread
document for atomic approval. Source-ID records with a seven-day TTL support
deletion of attributable public replies from external bots; unknown origins are
retained. See the same contract for private pagination and authority rechecks.

The `/ban_user` deletion fallback marks matching messages before plugin dispatch.
Both automatic-reply plugins honor that marker even if deletion is slow or fails.
The listener checks expiration on each message and belongs to the invoking bot
client and guild. See [temporary moderation](contributing/operations.md#temporary-moderation).

## Persistence and external services

[Repositories](../src/persistence/repositories/) form a per-guild bundle and can be
replaced with test fakes. Operational failures return `Result<T, DatabaseError>`;
missing records succeed with an empty result; invalid programmer arguments throw.
[MongoConnectionManager](../src/infra/mongo/connection-manager.ts) owns pooled
connections and bounded retries. See [database recovery](contributing/operations.md#database-recovery)
and [persisted models](contributing/persisted-models.md).

LLM, link-preview and social-feed strategies isolate provider behavior and errors.
Feed polling shares account reads; delivery and cursors remain per subscription.
Cursors advance after successful delivery; post IDs stay strings.

## Errors, logs and localization

`DomainError` carries a code, translation key, parameters and cause. Expected
failures use `Result`; adapters translate external errors. Pino logs include bot
and optional guild context; file output is JSON Lines under `logs/`.

User-facing strings use aligned English and Traditional Chinese
[catalogs](../src/i18n/locales/). CI scans application layers for CJK literals; the
guild-event mirror is an English operator audit surface. See
[Adding a command](contributing/adding-a-command.md).

## Privacy-aware data commands

[PermissionRankPolicy](../src/core/plugin/permission-rank-policy.ts) supplements
Discord permissions with static channel ranks and member clearance. Channel rank
includes ancestry; invalid configuration fails startup and unknown ancestry must
not widen access. Aggregate commands such as `/traffic overview*` must:

1. Include only channels passing the invoker's Discord `ViewChannel` check and rank
   ceiling, resolving the invoker's roles and permissions.
2. Cap public replies at `min(userRank, commandChannelRank)` and ephemeral replies
   at `userRank`; gate the invoker, not the report subject.
3. Exclude unknown/deleted channels and filter before aggregation. Use the same
   permitted channel set for all statistics and comparisons; keep empty results
   neutral so hidden channels are not revealed.

Feed commands use Discord visibility without rank gating and fail closed when
visibility cannot be resolved. Threads use parent checks; removal rechecks access
at confirmation and subscription checks the bot's ability to post.

Rank gates govern Discord disclosure, not host storage: logs and attachment caches
may contain private-channel data. See [attachment storage](configuration.md#attachment-storage).

## Deployment boundary

The launcher selects the project Conda runtime. Independent systemd units use release
snapshots with shared configuration, logs and data. A transaction journal supports
rollback; MongoDB has a separate lifecycle. See [deployment](contributing/deployment.md)
and the [migration runbook](../tools/migration/README.md).

## Message archive ownership

Only msg-archive receives the archive writer capability. Reader/writer connection
pools are separate; shared startup suppresses automatic archive collection/index
creation. Other bots expose archive reads while unrelated repositories retain writes.

The archive plugin owns the durable Gateway inbox, serialized mutations,
reconciliation and repair execution. Normalization and admission are shared domain
contracts. Repairs journal relationship mutations before applying them; structural
maintenance stays with the owner. Discord archive commands submit durable jobs
through an infra control service; handlers never become archive writers. Mutating
run controls require durable actor-bound confirmations. Results and journals
survive Discord interaction expiry and process restarts.
Repair cancellation state is scoped to one execution, with coalesced bounded-age
reads and a local shutdown signal. Job results are persisted before terminal
notifications; best-effort progress publication cannot replace the durable outcome.
The repair-to-history transition preserves committed phase totals in the shared
tracker. Terminal notices distinguish completed repair operations from scanned
messages and make stopped one-shot work explicit; recovery uses the existing run.
New enrichment records place `_id` first before their recovery images are hashed,
matching MongoDB's stored BSON field order without weakening hash verification.

The guided backup entry point reuses plan/apply/accept jobs. Apply already includes
post-backfill verification; acceptance retains fresh verification and a separate
confirmation before the recovery-retention clock begins. Public status messages
reconstruct their state from durable jobs/runs instead of relying on interaction
tokens. Runtime and handler edits share a serialized message coordinator: the
first embed is the live summary, and subsequent detail/confirmation state survives
ten-second heartbeat edits and restarts.
Successor jobs reuse the run's public message and mark predecessor notification
ownership as superseded, preventing delayed replay from replacing newer status.
Selected-plan panels render a fresh snapshot of the associated job above the
manifest summary without taking over its canonical notification. Refresh reads
latest durable progress; only the canonical notification has a heartbeat.
Planning jobs can be resolved through the guild-scoped `originatingJobId` until
`runId` is attached. Pause controls bind both run and exact job identities, expose
active work even when manifest aggregation is unavailable, and use cooperative
cancellation without changing recovery semantics. Resume remains unavailable
until the active job drains and existing eligibility checks pass.

Legacy runs without job records keep a `publicMessage` reference on the run;
this display metadata does not alter repair images or confirmation semantics.
Whole-manifest impact summaries use bounded server-side aggregation and safe
metadata projections; unavailable or unknown classifications remain explicit.
Target-aware inspection projects only allowlisted identity and difference fields
from journal images. One changes view shows at most ten concrete rows, up to five
per page, or grouped impacts with source examples for larger plans. Grouped
results distinguish record types, impacts and states; source counts cover the
complete selected scope, not the visible page. Category, source and individual
operation drilldowns, technical pages and downloads are not UI entry points.
Legacy detail controls redirect to the compact changes view. Routine views omit
internal IDs and hashes while retaining meaningful source identities. Cached
Discord metadata can enrich historical identities without a REST call per record.
Shared public navigation edits its originating message, keeping notification volume
independent of the number of changes. Canonical worker notifications and browsing
panels have separate references: opening another item removes an unrelated status
card, and its former publisher skips the repurposed panel. Explicit navigation to
the canonical item can restore its status. Approval records bind their displayed
panel without moving the successor job's canonical notification. Source labels require public readability
evidence; cached historical names do not bypass it. Raw recovery images never
reach presenters.
Read-only navigation rechecks guild permissions, and mutating buttons retain the
existing single-use, actor/channel-bound confirmation protocol.
Archive management exposes four entry points with button-only pages. Lists fetch
two entries and expose matching item buttons, refresh, next-page controls and
whole-list deletion, for at most five buttons. Longer legacy pages continue after the last displayed
entry so compact pagination cannot skip records. Item deletion and eligible rollback
use direct buttons; active-only filters and combined single-item stop-and-delete
buttons are omitted. Whole-list delete buttons open an all-pages review before
confirmation. Legacy select handlers and accepted cleanup batches
retain their existing authorization/recovery contracts without emitting new menus.
Eligible apply, resume and acceptance open scoped actor-bound confirmation
directly on the item panel. Public progress offers details and cooperative stopping
and retains the ten-second message cadence. Audit, standalone verification and
attachment-refresh entry points have been removed; legacy backend compatibility,
automatic apply verification and fresh acceptance validation remain intact.
Single-item deletion approvals are additionally message-bound, disposable five-minute tokens.
Accepted job deletion intents persist in `archive_control_deletions`; worker claim
and submission reject tombstoned identities. Cleanup waits for drained terminal
work, records the run identity before removing the job, releases consumer
reservations and retries final public notification after restart. These receipts
remain to fence stale confirmation replay. Run-consumer reservations retain hashed
request-to-process ownership; startup releases an absent-job reservation only
after proving the prior same-host process has stopped and its database operations
have drained. Unknown or live owners remain protected. Plan deletion reserves the
run against new consumers, checks operation/journal state and active jobs, then
removes only plan and operation/control metadata. Eligibility includes
never-applied plans and fully `rolled-back` plans whose operations are all
`rolled-back` or never-mutated `planned`, with no conflict records, journal, active
consumer or active job. The complete [eligibility rules](message-archive.md#discord-controls)
also protect incomplete rollback and remaining applied changes.
`archive_plan_deletions` fences retry/replay; archived messages are preserved.
Superseded publishers cannot revive deleted cards.
Final plan deletion notices re-read their message under the shared edit lock and
replace only a recognizable status card, preserving unrelated navigation and bulk
cleanup panels. Unmarked legacy standalone notices are left unchanged.
Bulk deletion stores bounded per-item snapshots in `archive_bulk_deletions` and
`archive_bulk_deletion_items`. An actor/channel/message-bound review becomes a
claimed execution; per-item outcomes survive interruption, and exact identities
exclude later arrivals. Reviews show eligible/protected counts and active jobs;
confirmation expires after five minutes. Existing single-item lifecycle checks
remain authoritative: job cleanup requests cooperative stopping before deletion,
and plan cleanup shares single-plan eligibility, including fully rolled-back plans
without conflicts or retained journals. Remaining applied changes and in-use plans
are protected.
A prior executor must be proven stopped before takeover. The whole-card bulk
presenter and ten-second heartbeat retain result/resume markers; ordinary job
notifications respect these markers even when cleanup deletes the card's source job.
Failed or incomplete reviews cannot execute. Snapshot cleanup atomically revokes
expired consent before removing items and preserves accepted running batches.

History pages preload archive snapshots in bounded batches; conditional mutations
still compare the complete observed image so a live edit cannot be overwritten by
a stale preload. Exact snapshot replays avoid replacement writes. Repair planning
reserves sequence ranges before majority/journaled manifest batches, reconciles
durable prefixes after partial failures, and keeps deterministic operation IDs.
Excluded sources are queued within the document/byte batch bounds. Related
revision and reaction records are streamed using batched identity queries, with
per-message dependency chains retaining related-before-source deletion order.
Apply batches contain only independent scopes with satisfied dependencies. Their
before-images become durable before target writes, and readback precedes verified
acknowledgement. Standalone MongoDB remains supported without transactions.
Enrichment, batched apply and rollback all combine an indexable native `_id`
equality predicate with the complete current-image comparison for conditional
delete/replace. Rollback retains reverse journal order. The ID index bounds candidate reads without weakening protection
against racing edits. Recovery does not parallelize arbitrary dependent operations.
History snapshot preparation is restricted to independent message identities and
flushes before repeated identities. Up to 25 messages share bounded journal and
verified bulk writes; revision waves precede message waves. Large images fall back
to single writes. Fresh REST observations with no reactions publish empty membership
references in the snapshot mutation, removing old references without a second write.
Cancellation, message observation watermarks and Gateway gap versions are checked
again inside the writer and before each dependent write wave; untrusted or nonempty
observations retain full enrichment. Checkpoints acknowledge only completed pages.
Versioned outcome counters distinguish legacy upgrades from content updates while
preserving older mixed totals. Fresh throughput samples exclude restored counters;
queued receipt hashes let notifications remove only obsolete submission details.
Unknown optional discovery fields are omitted so target records and durable
recovery images retain the same BSON representation.

The shared SDK REST manager owns transport retries and quotas. The owner scheduler
adds bounded, fair admission across guilds and reserves live capacity; announced
local waits can release admission capacity for other resources, while global waits
pause new requests. Each channel retains its ordered cursor with at most one
speculative next page. Checkpoints advance only after message writes and complete
reaction generations. History and reaction queues share a 64 MiB logical staging
budget with a reserved reaction lane; this is not a hard limit on V8/SDK transient
allocations or process RSS. Oversized pages produce partial coverage instead of
silently advancing a checkpoint.
Requests initially reserve their maximum allowed payload. Validated history pages
shrink that reservation to twice their encoded size; reaction pages discard user
profiles and retain only bounded ID arrays before storage. This releases unused
logical capacity without changing checkpoint or complete-generation requirements.
Channel discovery uses one fresh SDK inventory, with a raw fallback only for SDK
failure or unsupported channel types, and propagates scan cancellation and concurrency.
Activity snapshots select recent non-waiting work while detailed source pagination
retains stable ordering. Each real activity update advances its timestamp; bounded
reaction page and membership counters are provisional until generation publication.
The existing ten-second notifier samples these counters without extra Discord
requests per reaction page or invented movement during slow requests.
Per-guild `archive_schedule` state defaults to disabled and is controlled by
msg-archive's restricted slash command in the configured guild debug channel. Control jobs precede periodic scans;
disabling scans preserves live ingestion and resumable checkpoints.
Schedule updates are atomic and idempotent: repeating saved settings does not move
the due time or supersede the completion timer of an active pass. Stop/pause checks
also run between history write batches and reaction membership pages.
A due schedule that loses worker admission to a control job releases its claim
without advancing its due time; the next poll retries after that job drains.

See [archive operations](message-archive.md) for data contracts, repair controls and
[progress access](message-archive.md#progress-and-access).

The [developer archive benchmarks](../tools/archive-benchmark/README.md) exercise
the repair service and repository against disposable synthetic databases, and
history scheduling against a shared mock REST transport. Node and disposable
mongod process metrics are reported separately, excluding other services. CPU
worker offloading remains disabled following the measured adoption gate; see the
[performance evidence](contributing/archive-performance-results.md).

### Grouped command dispatch

Related slash commands share root handlers (`feed`, `reply`, `activity`,
`giveaway`, `ai`, `thread`, and `traffic`). `GroupedCommand` composes action
metadata into subcommands/groups and routes execution and autocomplete by the
exact group/subcommand pair. Each action retains its authorization and business
logic; internal `action.ts` modules are excluded from generated registration.
Localization follows the public root/subcommand path. Help displays executable
paths, and each root is enabled once in the bot's command configuration.
See the [migration table](upgrading.md#grouped-slash-commands).
