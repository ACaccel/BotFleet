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
