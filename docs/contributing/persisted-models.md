# Adding or removing a persisted model

Part of the [contributing guide](../../CONTRIBUTING.md).

`GuildModels` ([`GuildConnection`](../../src/persistence/connection.ts)) derives from
`SchemaName`. Update these together when adding or removing a model:

1. [Schema registry](../../src/persistence/schemas/index.ts).
2. [`buildRepos` / `Repos`](../../src/persistence/repositories/index.ts).
3. Role-aware initialization in [`src/infra/mongo/`](../../src/infra/mongo/);
   model registration derives from the schema registry.

Read and write every collection through a repository in
[`src/persistence/repositories/`](../../src/persistence/repositories/), including
collections without a mongoose schema; the archive repositories
(`archive*.repo.ts`) are the example. They are not part of `buildRepos`, whose only
archive member is the read-only `ArchiveStatsRepo`: the metadata repositories come
from `buildArchiveRepos` and the msg-archive writer's from `buildArchiveWriterRepos`,
both in [`archive-repos.ts`](../../src/persistence/repositories/archive-repos.ts); see
[layers and boundaries](../architecture.md#layers-and-boundaries).

Removing a model leaves its data intact. Collection cleanup is an operator action:
provide a dry-run-first [database tool](../../tools/db/README.md), never a startup migration.

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
out of panels and reports.

`Activity` stores an activity's state, participants and roll-call attendance,
keyed by its announcement message ID; `RollCall` stores who was called and who
checked in. Joining and checking in are single conditional updates, so concurrent
clicks cannot exceed a capacity or count twice. Both expire seven days after
closing through a TTL index on `purge_at`; earlier activity rows without the new
fields read as open activities with no creator.

`AiUsage` records only a member ID and request timestamp in each guild database;
its compound lookup index serves rolling usage windows and its timestamp index
expires records after 25 hours. Keep admission through `AiUsageRepo`, without
storing prompts or responses. See [AI policy](../configuration.md#ai-models-and-usage-limits).
