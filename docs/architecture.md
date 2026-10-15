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
| [application](../src/application/) | Feature services that handlers and plugins share           |
| [handlers](../src/handlers/)       | Commands and interaction entry points                      |
| [plugins](../src/plugins/)         | Features, subscriptions and scheduled jobs                 |
| [bot](../src/bot/)                 | Composition roots, service tokens and lifecycle            |

ESLint enforces boundaries. Each layer imports only layers listed before it in the
table: core nothing; persistence core (it declares the per-guild
[`GuildConnection`](../src/persistence/connection.ts) that `infra/mongo` builds);
infra core and persistence; application core, persistence and infra. Handlers and
plugins may import application and the layers it uses, but not each other; handlers
take `BaseBot` as a type only. Plugins use context instead of importing IoC or
`src/bot`, except the [tokens](../src/bot/tokens.ts) and
[guild lookup](../src/bot/guild-registry.ts) contracts, the only `src/bot`
modules they may import. An application service never imports `src/bot`: it declares a narrow
port, such as [`GuildLookup`](../src/application/guild-lookup.ts), that the
composition root's objects satisfy. Raw MongoDB access (a collection by name, or a
guild's models in handlers, plugins and application) belongs in persistence
repositories. `src/` cannot import `scripts/`; `tools/` owns operator workflows.

The application layer holds code with more than one consumer: the activity,
giveaway and temporary-role services, whose jobs plugins rebuild and commands
create, and archive control with the panels that the archive worker and the
`/archive` handlers both render. Code with a single consumer stays with it; the
archive panel publisher, storage admission and owner recovery belong to the
message-backup plugin runtime. Infra keeps adapters and probes only, such as
Discord helpers, the bounded HTTP client, connection management, MongoDB
administration commands, storage measurement and process checks.

## Startup and shutdown

Bootstrap validates configuration; [BaseBot](../src/bot/index.ts) builds services
and initializes plugins before login. Listeners attach before guild registration,
repository connection and ready hooks. Guild database failures are isolated and can recover.

Gopher has no database or inbound HTTP server. Its self-hosted LLM endpoint is
fixed at startup; operators apply changes through
[manual configuration and restart](configuration.md#gopher-llm-endpoint).

Startup rejection exits with failure. Shutdown cleans up resources within a deadline;
a second signal exits immediately. Discord handles reconnection. Uncaught exceptions
use a narrow transient-network whitelist, separate from ordinary retry policy.

`BOTFLEET_READY_FILE` attests startup readiness of Discord, repositories and plugins;
disabled plugins prevent publication. See [deployment](contributing/deployment.md)
for this startup marker, which does not indicate continuous health.

## Plugins and dependency injection

The typed [ServiceContainer](../src/core/ioc/) binds singleton services with
`ServiceToken<T>`. Factories and registries hold per-guild state. Handlers use BaseBot
accessors; plugins resolve the same instances through context. A token bound only by
some composition roots, such as msg-archive's `ArchiveControlFactory`, reads as
`undefined` elsewhere, and handler tests pass a fake in its place.

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

Components route by the leading custom-ID segment. `npm run handlers:gen` maintains registries, checked by CI.
The router translates domain failures into ephemeral replies; failed autocomplete
returns no suggestions. Shared Discord utilities live in `infra/discord`.

The channel-logging middleware mirrors commands as localized embeds to the
configured debug channel after dispatch, including when dispatch throws.
It applies the `channel_logging` permission-rank ceiling without suppressing the
durable guild audit trail. See [command log presentation](configuration.md#common-bot-settings).

### Mention and role safety

Text that members author and the bot re-posts carries explicit `allowedMentions`:

- Stored auto-replies (including `[*]`) and `/reply list` ping nobody.
- `/talk` signs messages by default and checks the member's destination-channel
  permissions. It may ping members and roles, never `@everyone`/`@here`;
  `anonymous:true` is limited to bot admins and records the sender in logs.
- A `/ban_user` vote pings only the guild's `roles.ban_user`, and nobody when it is
  unset; bots cannot be voted on.
- Giveaway results ping only the winners and the prize owner; the prize text cannot.
- Activity announcements ping only their participants, and a roll call only the
  members it calls (at most 50).

`/bug_report` tickets live in the hub guild's database, not the reporter's, because
one forum serves every guild a bot is in. The bug-report plugin relays admin
replies in a ticket's forum post to the reporter's DMs (messages starting with
`//` stay internal) and the reporter's DMs back to the post, routed by the ticket
number in the quoted DM, the only open ticket, or a menu. Both directions ping
nobody. Nijika and Tomori receive DMs through `Partials.Channel`.

Konata's notification relay accepts updates only on `127.0.0.1`, with a bearer key
compared in constant time ([`createBearerCheck`](../src/core/http/bearer.ts)) before route lookup or body parsing. Callers name a
configured route, never a channel, and their text pings nobody. Updates for one
thread are serialized in process; the thread's message ID lives in the route guild's
database, so a restart keeps editing the same message. See the
[API contract](configuration.md#notification-relay-api).

Nijika and Tomori's earthquake early-warning APIs use the same model: `127.0.0.1` only, behind
`tailscale serve`, with the shared bearer check before routing or body parsing. An
alert whose arrival time is over 10 minutes old is acknowledged as a test without
posting, which also blocks replays. Alerts are serialized through one in-memory
queue; an alert close in time and place to the open event edits that event's
messages instead of posting, and only the event's first alert at the configured
local intensity (`earthquake_alert.ping_min_local_intensity`, default 4) pings the guild's `earthquake` role. Event state is not persisted. See the
[API contract](configuration.md#early-warning-api).

Activities and roll calls are button-driven and persisted per guild. The activity
plugin rebuilds both on startup and database recovery: an activity whose
sign-up deadline passed while the bot was down closes immediately, a start
reminder more than an hour late is skipped, and a roll call past its deadline
closes and records attendance on its activity. Closed records expire after seven
days through TTL indexes.

Self-service role buttons grant only roles that pass
[`isSelfAssignableRole`](../src/infra/discord/self-assignable-role.ts): below the
bot's highest role, not integration-managed, and without moderation or
administrative permissions. A `/role panel` author may only offer roles below
their own highest role, and the button rechecks the role on every click.

`/role temp` uses the shared temporary-role application service for creation,
listing and early cancellation. Creation is serialized per guild within each
process to enforce
member caps and name uniqueness. Cancellation retains the stored record and
expiry job if Discord refuses deletion. `/role sync` resolves configured level
roles by ID, bounds member batches and role-edit concurrency, and reports
failures; it adds the target role before removing obsolete level roles.

`/level_detail` and `/role sync` share one MEE6 leaderboard read per guild, cached
for five minutes ([`mee6-shared/leaderboard.ts`](../src/handlers/commands/mee6-shared/leaderboard.ts)).
The public leaderboard's ◀ / ▶ buttons carry `level_page|<invokerId>|<page>`; only
the invoker may page, and each press re-reads the cached board and clamps the page.

## Discord presentation colors

[`presentation-colors.ts`](../src/infra/discord/presentation-colors.ts) owns the
shared `EMBED_COLORS` palette. Choose colors by state before feature identity;
titles, text and buttons must also communicate the state.

| Token         | Color     | Use                                                        |
| ------------- | --------- | ---------------------------------------------------------- |
| `info`        | `#5865F2` | Queries, help, reports, progress, role and message updates |
| `success`     | `#57F287` | Completed operations and approved requests                 |
| `warning`     | `#FEE75C` | Attention needed, known gaps and pending review            |
| `neutral`     | `#99AAB5` | Stopped, rejected, expired and deletion records            |
| `error`       | `#ED4245` | Failed operations                                          |
| `celebration` | `#9B59B6` | Activity and giveaway announcements                        |

The avatar context menu uses `info`. Archive renderers map their
existing state rules through `ARCHIVE_COLORS`; a full backup's `partial` result is
an error, while a periodic pass's `partial` result is a warning.
Social cards retain source identity through `SOCIAL_COLORS` (X `#1D9BF0`, Facebook
`#1877F2`), including Components V2 accents; generic previews use `info` and
auxiliary gallery embeds omit color.
Relayed notifications show a running thread as `info`, success as `success`, failure
as `error` and cancellation as `neutral`.
CWA earthquake report embeds use `EARTHQUAKE_REPORT_COLORS` to mirror the agency's
own report color (green, yellow, orange, red) as a severity cue; an unknown color
falls back to `info`. Early-warning embeds reuse its red at or above the configured ping threshold and
its orange below. Shared `replyForError` replies remain localized
plain text.

## Temporary moderation and automatic replies

Persistent [thread moderation](thread-moderation.md#implementation-contract) runs
in `ClientEventBridge` before concurrent plugin dispatch and interaction routing.
It is opt-in per bot and enabled in Nijika's configuration.
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

Tomori and Nijika share a [guild settings service](tomori-settings.md) factory in
`src/bot/guild-settings.ts`. It uses an application-scoped
singleton in each guild database, an atomic revision/operation-ID update with
bounded audit history, owner-bound temporary drafts and per-field authority.
Saved preferences are distinct from immutable effective snapshots constrained by
operator capabilities. A fixed application control-database inventory separates
legacy seeds from later guild defaults. Commands/components and plugins share
feature scopes; destination resolution checks guild ownership at use time.
Missing settings fail closed and retry without blocking other guilds.
Versioned reads upgrade old settings with a guarded CAS while preserving history.
Guild locale/time-zone resolution uses asynchronous context around interactions,
events and scheduled work; explicit UI locales remain authoritative. Individual
entertainment switches/cooldowns and fresh-member moderation voter checks use the
same committed guild snapshot. See the panel guide for bounds and defaults.
Both bots manage social-feed subscriptions through `/feed`. Tomori's earthquake
section has separate warning/report switches, a shared destination and an optional
warning role; all delivery starts disabled. Upstream capability checks constrain
the switches, and delivery revalidates current preferences, destinations and roles.
CWA reports never mention anyone. Schema version 4 adds disabled earthquake defaults
and removes the retired targeted-reply flag while preserving revision/history.
Nijika's earthquake notifications and level-role sync retain deployment controls.

[Repositories](../src/persistence/repositories/) form a per-guild bundle and can be
replaced with test fakes. Operational failures return `Result<T, DatabaseError>`;
missing records succeed with an empty result; invalid programmer arguments throw.
The msg-archive repositories (writer, control and archive metadata) are the
exception: they throw driver errors, which the worker classifies and the `/archive`
handlers report with a trace ID.
[MongoConnectionManager](../src/infra/mongo/connection-manager.ts) owns pooled
connections and bounded retries. See [database recovery](contributing/operations.md#database-recovery)
and [persisted models](contributing/persisted-models.md).

LLM, link-preview and social-feed strategies isolate provider behavior and errors.
The application AI policy validates model allowlists/defaults and rolling usage
limits; `/ai` settings and the LLM plugin share that policy. The plugin checks
session ownership and nonempty input before admission, reserves concurrency, and
serializes each member's quota admission within its process. Per-guild
`AiUsageRepo` stores only user IDs and timestamps, with a 25-hour TTL; its rolling
counts survive restarts. See [AI configuration](configuration.md#ai-models-and-usage-limits)
for admin exemptions, fallback behavior and cross-process limits.

The X provider reads posts from a JSON API into a neutral post model and keeps
the proxy rewrite only for videos a proxy can play. Link previews and X feed
subscriptions share this provider and the Discord renderer in
[`infra/discord/social-preview.ts`](../src/infra/discord/social-preview.ts): classic
embeds, or a Components V2 card with all post metadata above an uploaded video.
Feed platforms return neutral single-message previews; each account pass shares post preparation
across its destinations. Feed announcements and media use one send, and preview
failure falls back to the existing proxy announcement. Feed configuration remains
independent of the message-preview plugin.
Threads retains validated proxy OpenGraph metadata for custom cards instead of
depending on a second fetch by Discord's URL crawler. Facebook retains metadata
from proxies or the source site. Both preserve the complete image list. The renderer
sends all distinct HTTPS images in four-image gallery replies; only the first
reply carries the post text. Facebook-specific parsing maps the proxy's source
summary to optional engagement counts. Direct videos use a dedicated downloader with the shared host validation and
bounded DNS resolver, plus address checks, deadlines and a concurrency limit;
the renderer places all card metadata above the video in one Components V2 message
for either source and falls back if Discord rejects the upload.
Missing or failed media delivery keeps the card and adds a fallback link. See
[preview configuration](configuration.md#social-previews-and-feeds) for supported
media, limits and metadata availability.
Feed polling shares account reads; delivery and cursors remain per subscription.
Cursors advance after successful delivery; post IDs stay strings.

nhentai and wnacg links are gallery providers in the same registry, so they share
URL extraction, the provider kill-switch and per-guild provider preferences, but
their `gallery` result never reaches the static renderer. The plugin skips them
outside age-restricted channels before any request and otherwise posts a reader
message through the [gallery reader](../src/application/gallery-reader/service.ts),
which it publishes as `TOKENS.GalleryReader` for the stateless `gallery_page`
button and form handlers (any member may page; the custom ID names only the
target). The reader caches metadata with shared in-flight reads, keeps
downloaded pages in a byte-bounded LRU, prefetches neighbours behind a
two-priority download limit, refetches metadata once when page URLs go stale,
and serializes turns per message. Pages are uploaded rather than hot-linked
because source image URLs carry expiring signatures. Uploading during a turn
dominates its latency, so with a staging channel the reader uploads prefetched
pages ahead through a `GalleryStagingPort`, implemented by
[`DiscordGalleryStaging`](../src/infra/discord/gallery-staging.ts), warms
Discord's media proxy for each, and turns to a staged page by swapping the embed
URL; unstaged pages are attached to the edit. The adapter validates the channel
at use time and deletes its own messages after a day.

## Errors, logs and localization

`DomainError` carries a code, translation key, parameters and cause. Expected
failures use `Result`; adapters translate external errors. Archive control use cases
return `Result<T, ArchiveControlError>` for a stale, foreign or conflicting request;
the `/archive` interaction boundary raises `ArchiveAccessError` and
`ArchiveInputError` itself, and answers all three privately with their keys.
`ConfigurationError` marks a deployment fault: startup, setup and release
preparation raise it fail-fast, and a feature that finds one only when used (the
canvas font when a chart first renders, the archive settings an interaction
rereads) raises it for the interaction boundary to log and answer with a trace ID.
Pino logs include bot and optional guild context; file output is JSON Lines under `logs/`, and each
process deletes dated files older than `LOG_RETENTION_DAYS` (default 60; see
[configuration](configuration.md#log-retention)).

User-facing strings use aligned English and Traditional Chinese
[catalogs](../src/i18n/locales/). CI scans handlers, plugins, application, bot and
infra for CJK literals; the guild-event mirror is an English operator audit surface. See
[Adding a command](contributing/adding-a-command.md).

## Privacy-aware data commands

[PermissionRankPolicy](../src/core/plugin/permission-rank-policy.ts) supplements
Discord permissions with static channel ranks and member clearance. Channel rank
includes ancestry; invalid configuration fails startup and unknown ancestry must
not widen access. Aggregate commands such as the `/traffic` subcommands and
archive-aware `/gay` readings must:

1. Include only channels passing the invoker's Discord `ViewChannel` check and rank
   ceiling, resolving the invoker's roles and permissions.
2. Cap public replies at `min(userRank, commandChannelRank)` and ephemeral replies
   at `userRank`; gate the invoker, not the report subject. A public reply also
   needs audience coverage: every role, `@everyone` included, that can view the
   command channel must view the counted channel (threads through the parent), and
   private threads never count publicly.
3. Build candidates from `archive_channels` plus the guild cache. Judge threads,
   archived ones included, through the parent (rank through the recorded parent
   chain); count a private thread, or a recorded thread of unknown type, only when
   the invoker has Manage Threads on the parent. Count a channel missing from the
   cache only when its record says it was deleted, its last record says `@everyone`
   could view it, and its rank passes.
4. Filter before aggregation (`channelId: { $in: [...] }`). Use the same permitted
   channel set for all statistics and comparisons; keep empty results neutral so
   hidden channels are not revealed; a report about one named channel answers a
   hidden channel exactly like a missing one. Emoji and sticker usage counts are the
   only exception: they cover every channel and show no channel information.

The filter is [`resolveVisibleChannelIds`](../src/handlers/commands/traffic-shared/visibility-filter.ts),
a pure function over injected cache and record lookups.

`/gay` uses a dedicated read-only `GayStatsRepo` with a 500 ms summary budget,
filtering the current public scope before querying or reusing a result. Its
`GayReadingRepo` atomically stores scores in `gay_readings`, outside the archive;
snapshot identities include the permitted channels and expire through a TTL
index. Missing archive data or failed reads keep the basic daily calculation.
See [daily fun readings](fun-readings.md) for the calculation and fallback contract.

Feed commands use Discord visibility without rank gating and fail closed when
visibility cannot be resolved. Threads use parent checks; removal rechecks access
at confirmation and subscription checks the bot's ability to post.

Rank gates govern Discord disclosure, not host storage: logs and attachment caches
may contain private-channel data. See [attachment storage](configuration.md#attachment-storage).

## Database inspection

Nijika's `/db` reads any guild database through the db-inspect plugin and
[`DbInspectService`](../src/application/db-inspect/service.ts):

- **Read-only account.** Plugin `init` opens a separate client on
  `MONGO_INSPECT_URI` and rejects an unauthenticated account or one granting any
  action beyond read and statistics. It bypasses `MongoConnectionManager`, whose
  model registration builds indexes and would create a database for a guild without one.
- **Catalog.** [`INSPECT_CATALOG`](../src/persistence/inspect/catalog.ts) derives
  fields, enum values, index keys and timestamp fields from the schema registry,
  and lists collections that repositories use without a schema; their fields, and
  those of unregistered collections, are inferred from the newest documents.
- **Structured filters.** A filter is a catalog field, an operator valid for its
  type and a value converted to that type; values never become query operators,
  and `contains` matches literally. No raw queries or aggregation.
- **Limits.** Queries stop after 5 seconds (autocomplete 1.5 seconds), filtered
  counts at 10,000, and paging at the first 10,000 matches. Sorting is limited to
  `_id` and leading index keys; filters on unindexed fields are flagged as slow.
- **Sessions.** A result panel's buttons carry a token for an in-memory session
  bound to the invoker, expiring 15 minutes after last use or on restart.
- **Access and audit.** Only `admin` IDs may run the command or its components;
  autocomplete returns nothing to others. Replies are ephemeral with no mentions.
  Each read logs `ops:db_inspect.read` with the user, database, collection and
  filter, never results.

`/db` is a deliberate exception to [privacy-aware data commands](#privacy-aware-data-commands)
and to the archive rule that panels omit message content: it serves bot admins
only, privately.

## Deployment boundary

The launcher selects the project Conda runtime. Independent systemd units use release
snapshots with shared configuration, logs and data. A transaction journal supports
rollback; MongoDB has a separate lifecycle. A separate systemd timer takes daily online
database dumps. See [deployment](contributing/deployment.md), the
[backup guide](../tools/mongo-backup/README.md) and the
[migration runbook](../tools/migration/README.md).

## Message archive ownership

Only msg-archive receives the archive writer capability. Reader/writer connection
pools are separate; shared startup suppresses automatic archive collection/index
creation. Other bots expose archive reads while unrelated repositories retain writes.
[`ArchiveStatsRepo`](../src/persistence/repositories/archive-stats.repo.ts) is the
read-only statistics reader every bot receives: aggregations only, combined per
command with `$facet` over one indexed scan, each limited by `maxTimeMS` (60
seconds); an exceeded limit is a `DatabaseError` with code `DATABASE_QUERY_TIMEOUT`.
The scan index is chosen explicitly: `createdTimestamp` for scopes covering most
channels, `{ channelId, createdTimestamp }` for narrow ones, because a channel-order
scan over most of the guild thrashes the cache. Timezone bucketing happens on
15-minute UTC groups in the repository rather than per document. Its counting rules (deleted messages count; documents
without `author`, bots, webhooks and system messages do not) and the channel
attribution rule live in [`core/archive/stats`](../src/core/archive/stats.ts).

The archive plugin owns the durable Gateway inbox, serialized mutations,
reconciliation and full-backup execution. Normalization, observation merging and
admission (`core/archive/normalize`, `core/archive/policy`) are shared domain
contracts; structural maintenance stays with the owner. Discord commands enqueue
full-backup jobs and read status through the application
[control service](../src/application/archive/control.ts), built per guild by the
`ArchiveControlFactory` token only msg-archive binds (over `buildArchiveRepos`); handlers never become archive
writers. The service is a facade over job commands, start confirmations, schedule
settings and status queries (`control-jobs`, `control-confirmation`,
`control-schedule`, `control-status`). Every archive collection has a persistence
repository, and [`archive-repos.ts`](../src/persistence/repositories/archive-repos.ts)
holds the two archive factories. `buildArchiveWriterRepos` builds the writer's
repositories (messages, inbox, reactions, channels with their fetch cursors, jobs,
and the owner lease with structural maintenance); each refuses a connection without
msg-archive ownership, and the plugin injects the factory into the worker.
`buildArchiveRepos` builds one each for control (confirmations, jobs and status
reads), the periodic run, the schedule, Gateway continuity and storage usage, for
both the control factory and the worker. The per-bot `buildRepos` holds no archive
writer: archive access is limited to the read-only `ArchiveStatsRepo` and
`GayStatsRepo`; daily fun scores use the separate `GayReadingRepo`.

The [worker](../src/plugins/message-backup/runtime/worker.ts) is a facade that keeps
each guild's state and lifecycle and delegates to one collaborator per
responsibility: Gateway capture, inbox reduction, continuity, channel location
(`ChannelLocator`), REST evidence windows (`SourceObservations`), history ingestion
with reaction refresh, scans (`ScanRunner`, one `ScanPass` per scan, whose
`ScanMode` separates periodic passes from full backups and their checkpoints),
periodic passes, full-backup jobs, progress publication, notification recovery and
storage reporting. A per-guild work slot arbitrates between periodic passes and full
backups. Collaborators share a worker context narrowed to the options each reads,
keep their own fields of the guild state in their own sub-records, and receive each
other as narrow `Pick`-based dependency ports through their constructors.

`messages` documents use schema version 3 (`persistence/schemas/message.schema.ts`):
the Discord message ID is `_id`, field names follow discord.js, and an absent field
means "not observed". Each write merges an observation into the stored document:
stale observations (an older edit time, or the same version observed earlier) only
fill fields the document lacks, a newer one replaces only the fields it carries, and an edit moves the
previous content into the document's bounded `editHistory` in the same
replacement, so no separate revision collection or write-ahead marker is needed.
Messages carry no guild, channel name or parent: the database is the guild, and
`archive_channels` holds one record per channel or thread, written by discovery,
by live capture for a channel it does not know yet (an in-process set avoids a
lookup per message) and by Gateway channel events; deleted channels keep their
record. Policy decisions take the guild and parent from the event, the client cache
or `archive_channels` (fetching an unknown channel for bot and webhook messages).
An unlisted bot's interaction reply is admitted as an interaction record that keeps
only identifying fields and lists the rest in `excludedFields`; a message whose
author is unknown keeps only its identity, and its content stays out of the inbox,
until a REST read classifies it. `MessageDoc` is the writer's `ArchiveMessage`, and
compile-time checks pin the mongoose schema's fields and required fields to it.
Inbox events are discriminated by kind and validated when claimed.

A full backup is one `archive_jobs` record with a cutoff fixed at confirmation; a
partial unique index on `activeSlot` allows one queued or running backup per guild.
Start approvals persist in `archive_control_confirmations`, bound to the operator,
channel and message for five minutes, and a replay returns the job it already
created. The worker runs the job as its own full scan with per-channel checkpoints
kept apart from periodic ones (`archive_channels.checkpoints`), so neither kind
resets the other, and dispatches sources largest first by estimated work
(`flow/source-work.ts`; see [full backup](message-archive.md#full-backup)). A queued
backup preempts a periodic pass at a safe boundary and periodic passes wait until it
ends. Stop requests are polled at scan boundaries at most every 250 ms; a failed
lookup counts as no stop and is asked again at a later boundary (programmer errors
still fail it). Shutdown leaves
the job running and startup queues it again with its cutoff and checkpoints. A
source that fails transiently (Discord 5xx, 429 or timeouts, database timeouts or
network errors, a full in-process queue) runs again from its checkpoint in the same
sweep after a bounded backoff, behind the sources still waiting, so a retry never
holds a reader; other failures end the source for the sweep. Blocking issues are
kept per source, and a source that later completes drops its own
(`runtime/history-scan.ts`, `runtime/source-failure.ts`).
A completed backup settles Gateway continuity like a full periodic run, against the
origin recorded at its first start. The terminal state is written with bounded
retries before the slot is released, then shown. Job
and periodic-pass records are pruned to the ten newest finished ones, never an
active backup, the newest complete one or the newest resumable one.

Panels render in the application layer from durable job, run, schedule and channel records, so the
worker and button handlers share one renderer. The worker edits only a backup's own
panel message, through a per-guild publisher the plugin injects, and leaves it alone while an operator shows gap details; worker and
handler edits of one message share an in-process lock. Each periodic pass starts one best-effort progress embed in the debug channel,
replacing the previous pass's message. Progress and the final result edit the same
message; its ID and pass start time are tracked in `archive_schedule`; three consecutive failures raise one notice stored there, and
the next complete pass raises one recovered notice, each delivered once across
restarts and mentioning the bot's admins. Discord's invalid-request count gets the same treatment in its own
`archive_schedule` document: one warning per episode and one recovery (see
[invalid-request protection](message-archive.md#invalid-request-protection)). The worker persists its latest host storage sample for status; message
backup size comes from MongoDB collection statistics. Background samples walk the
MongoDB data directory each time and reuse the size of the project, runtime and
additional roots for ten minutes (never at 90% of the budget); writers do not wait
for a sample younger than twice its maximum age. Every command and button
rechecks the bot's `admin` list, `backup_server`, the guild debug channel and
msg-archive ownership; the command carries no Discord default member permission.

History pages preload archive snapshots in bounded batches; conditional mutations
still compare the complete observed image so a live edit cannot be overwritten by
a stale preload. Exact snapshot replays avoid replacement writes. Standalone
MongoDB remains supported without transactions. Conditional writes combine an
indexable native `_id` equality predicate with the complete current-image
comparison, so the ID index bounds candidate reads without weakening protection
against racing edits. History snapshot preparation is restricted to independent
message identities and flushes before repeated identities. A page's messages, up
to 500 documents and 4 MiB per writer turn, share bounded verified bulk writes, one
write per message; a turn whose stored images exceed the byte bound is halved, and
large documents fall back to single writes. A write that changes only backup
metadata (`observedAt` and the reaction freshness fields) is a `$set`/`$unset`
under the same full-image fence instead of a replacement. Fresh REST observations
with no reactions publish empty membership references in the snapshot mutation,
removing old references without a second write. A message whose lists are refreshed
is marked stale by that same snapshot write; its staged membership chunks are
inserted together, and one write publishes every refreshed stream with its
freshness. An incremental periodic pass keeps lists that Gateway continuity proves
current instead of rereading them (see [backup throughput](message-archive.md#backup-throughput)).
A message whose membership refresh fails stays marked stale and its page still
checkpoints; interruption, capacity pressure and programmer errors still fail the
page.
Cancellation, message observation epochs and Gateway gap versions are checked
again inside the writer and before each dependent write wave; untrusted or nonempty
observations retain full enrichment. The bounded table of recently observed
messages invalidates only readers older than an evicted observation; Gateway gap
versions advance only when events may have been lost. A durable per-guild
continuity record carries the gap version and full-reconciliation requirement
across restarts, and indexed continuity breaks (restarts, replaced sessions,
source visibility changes) bound the incremental rescan until a run created after
them completes. Readers pin the messages
whose evidence they hold, so settling an acknowledged event cannot hide a change
from them. Failed live reconciliations are classified by typed errors and their
causes: inaccessible sources become coverage gaps, capacity pressure and transient
faults wait uncounted (transient ones for at most a day), superseded events are
dropped, and other failures back off until the event is dead-lettered. The next
periodic run rescans a dead letter's source and reports it as a known gap. Each
ready guild reduces its inbox in its own loop, woken by captures; history pages
never wait for it, and a pass waits for one round only before it is planned and
before it judges completion. A complete MESSAGE_CREATE is stored without a REST
read, and a reaction event rereads only the list it names while the others are
complete and unmarked.
Checkpoints acknowledge only completed pages.
Outcome counters distinguish inserted, updated and unchanged messages. Fresh
throughput samples exclude restored counters. Reaction membership chunks
(`archive_reactions`, keyed by custom emoji ID or Unicode emoji and carrying the
message's channel) are collected once neither the message's published
`reactionGenerations` nor an in-flight refresh references their generation and
they are older than a day.

The shared SDK REST manager owns transport retries and quotas. The owner scheduler
adds bounded, fair admission across guilds and reserves live capacity; announced
local waits can release admission capacity for other resources, while global waits
pause new requests. While Discord's invalid-request count is high the owner caps
background (history and enrichment) admission below the concurrency. Gateway capture
and live message reads are never capped; reaction-list reconciliation of live events
shares the background cap, since its reads can produce invalid requests too
(`flow/invalid-request-guard.ts`, `runtime/invalid-request-monitor.ts`). Admission runs at most one request per route and channel, the
unit `@discordjs/rest` serializes, so a channel's history pages, message reads and
reaction lists proceed in parallel. Each channel retains its ordered cursor with at
most one speculative next page. Checkpoints advance only after message writes and complete
reaction generations. History and reaction queues share a 128 MiB logical staging
budget with a reserved reaction lane; this is not a hard limit on V8/SDK transient
allocations or process RSS. Oversized pages produce partial coverage instead of
silently advancing a checkpoint.
History requests initially reserve their maximum allowed payload and reaction
requests a page estimate, which a larger response grows before staging. Validated
history pages shrink that reservation to twice their encoded size; reaction pages
discard user profiles and retain only bounded ID arrays before storage. This releases unused
logical capacity without changing checkpoint or complete-generation requirements.
Channel discovery uses one fresh SDK inventory, with a raw fallback only for SDK
failure or unsupported channel types, and propagates scan cancellation and concurrency.
Activity snapshots select recent non-waiting work while detailed source pagination
retains stable ordering. Each real activity update advances its timestamp; bounded
reaction page and membership counters are provisional until generation publication.
The existing ten-second notifier samples these counters without extra Discord
requests per reaction page or invented movement during slow requests.
Per-guild `archive_schedule` state defaults to disabled and is controlled by
msg-archive's restricted slash command in the configured guild debug channel. A queued
full backup precedes periodic scans; disabling scans preserves live ingestion and
resumable checkpoints.
Schedule updates are atomic and idempotent: repeating saved settings does not move
the due time or supersede the completion timer of an active pass. Stop/pause checks
also run between history write batches and reaction membership pages.
A due schedule that loses worker admission to a full backup releases its claim
without advancing its due time; the next poll retries after that backup ends.

See [archive operations](message-archive.md) for data contracts, the
[full backup](message-archive.md#full-backup) and [progress](message-archive.md#progress).

The [developer archive benchmarks](../tools/archive-benchmark/README.md) exercise
normalization, repository writes and progress publication against disposable
synthetic databases, and history scheduling against a shared mock REST transport. Node and disposable
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
