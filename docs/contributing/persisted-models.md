# Adding or removing a persisted model

Part of the [contributing guide](../../CONTRIBUTING.md).

`Models` is derived from `SchemaName`, so a model is not a single
file — adding or removing one touches three places together, and
missing any of them breaks the build or leaves a dangling registration:

1. the schema registry in `src/persistence/schemas/`,
2. the repository bundle (`buildRepos` / `Repos` in
   `src/persistence/repositories/index.ts`),
3. the connection manager's model registration in
   `src/infra/mongo/`.

Removing a model does **not** delete the data. A collection left behind
in every guild's database is an operator action — ship a dry-run-first
subcommand under `tools/db/` (see
[`tools/db/README.md`](../../tools/db/README.md)) rather than a startup
migration inside the long-lived runtime.

## Thread moderation records

`ThreadModeration` stores bot/thread-scoped restrictions, delegated managers,
claims and management audits in each guild database. `ThreadMessageSource` stores
verified message-origin IDs with a seven-day TTL. The
[implementation contract](../thread-moderation.md#implementation-contract) owns
the index, atomic-update, expiry and retention rules. Preserve these guarantees
when changing schemas or repository methods; cover races with integration tests.
