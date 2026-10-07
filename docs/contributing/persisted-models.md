# Adding or removing a persisted model

Part of the [contributing guide](../../CONTRIBUTING.md).

`Models` derives from `SchemaName`. Update these together when adding or removing a model:

1. [Schema registry](../../src/persistence/schemas/index.ts).
2. [`buildRepos` / `Repos`](../../src/persistence/repositories/index.ts).
3. Role-aware initialization in [`src/infra/mongo/`](../../src/infra/mongo/);
   model registration derives from the schema registry.

Removing a model leaves its data intact. Collection cleanup is an operator action:
provide a dry-run-first [database tool](../../tools/db/README.md), never a startup migration.

`ThreadModeration` stores bot/thread-scoped restrictions, delegated managers,
requests and audit entries in each guild database. `ThreadMessageSource` stores
seven-day source-ID records with TTL cleanup;
see its [storage contract](../thread-moderation.md#implementation-contract).

Only msg-archive initializes archive collections/indexes after acquiring ownership.
Keep new archive schemas within that boundary and other bots' repositories read-only;
see [archive contracts](../message-archive.md#scope-and-retention).
Archive jobs, repair manifests and confirmation tokens persist across restarts;
their operator controls live in [Discord](../message-archive.md#discord-controls).
Keep sensitive recovery payloads out of reports and autocomplete results.
