# Adding or removing a persisted model

Part of the [contributing guide](../../CONTRIBUTING.md).

Tomori's `GuildSettings` and `GuildSettingsMigration` models use application keys,
versioned CAS writes and fixed migration inventory. Follow the
[settings persistence contract](../tomori-settings.md#defaults-migration-and-recovery)
when changing their schemas or operator capabilities. Schema version 2 upgrades
version-1 records with defaulted new sections while preserving revision/history;
exercise concurrent upgrade-versus-save races before altering that contract.

`GuildModels` ([`GuildConnection`](../../src/persistence/connection.ts)) derives from
`SchemaName`. Update these together when adding or removing a model:

1. [Schema registry](../../src/persistence/schemas/index.ts).
2. [`buildRepos` / `Repos`](../../src/persistence/repositories/index.ts).
3. Role-aware initialization in [`src/infra/mongo/`](../../src/infra/mongo/);
   model registration derives from the schema registry.
4. The `/db` [inspection catalog](../../src/persistence/inspect/catalog.ts): fields
   derive from the schema; add summary fields, and a
   `replies:db_inspect.collections.<name>` description in every locale. A collection
   read without a schema goes in its schemaless list; a test checks both.

Read and write every collection through a repository in
[`src/persistence/repositories/`](../../src/persistence/repositories/), including
collections without a mongoose schema; the archive repositories
(`archive*.repo.ts`) are the example. They are not part of `buildRepos`, whose only
archive member is the read-only `ArchiveStatsRepo`: the metadata repositories come
from `buildArchiveRepos` and the msg-archive writer's from `buildArchiveWriterRepos`,
both in [`archive-repos.ts`](../../src/persistence/repositories/archive-repos.ts); see
[layers and boundaries](../architecture.md#layers-and-boundaries).

Removing a model leaves its data intact. Collection cleanup is an operator action:
ship a dry-run-first one-off script under `tools/`, never a startup migration.

`Reply` records who added each auto-reply in `created_by`, which `/reply delete`
checks; pairs stored before the field existed have none and need a member with
Manage Messages.

`ThreadModeration` stores bot/thread-scoped restrictions, delegated managers,
requests and audit entries in each guild database. `ThreadMessageSource` stores
seven-day source-ID records with TTL cleanup;
see its [storage contract](../thread-moderation.md#implementation-contract).

Only msg-archive initializes archive collections/indexes after acquiring ownership.
Keep new archive schemas within that boundary and other bots' repositories read-only;
see [archive contracts](../message-archive.md#scope-and-retention).
Full-backup jobs, periodic-pass records, schedule notices and confirmation tokens
persist across restarts; their operator controls live in
[Discord](../message-archive.md#discord-controls). Keep message content and raw errors
out of panels and reports; admin-only `/db` is the exception.

`Activity` stores an activity's state, participants and roll-call attendance,
keyed by its announcement message ID; `RollCall` stores who was called and who
checked in. Joining and checking in are single conditional updates, so concurrent
clicks cannot exceed a capacity or count twice. Both expire seven days after
closing through a TTL index on `purge_at`; earlier activity rows without the new
fields read as open activities with no creator.

`BugTicket` stores ticket metadata (number per bot, reporter, source, forum post,
status) in the configured hub guild's database; the conversation stays in Discord.
Handlers reach it through `hubTicketStore`, not `buildRepos`.

`NotificationThread` maps a relayed notification thread (bot, route and caller key)
to its Discord channel and message ID in the route guild's database, so konata's
[notification relay](../configuration.md#notification-relay-api) keeps editing one
message across restarts. It stores no message text and expires 30 days after its
last update through a TTL index on `updated_at`.

`AiUsage` records only a member ID and request timestamp in each guild database;
its compound lookup index serves rolling usage windows and its timestamp index
expires records after 25 hours. Keep admission through `AiUsageRepo`, without
storing prompts or responses. See [AI policy](../configuration.md#ai-models-and-usage-limits).
