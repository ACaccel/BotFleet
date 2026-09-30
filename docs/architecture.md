# Architecture

BotFleet runs each personality as a separate process. A composition root selects
plugins, supplies configuration and connects a shared core to Discord, MongoDB
and external providers. See [Contributing](../CONTRIBUTING.md) for implementation
recipes and [Configuration](configuration.md) for operator settings.

## Layers and boundaries

```text
             bot/                 composition and lifecycle
               |
      handlers/   plugins/        interactions and features
               |
    persistence/   infra/         storage and external adapters
               |
             core/                contracts and shared mechanisms
```

| Layer                              | Responsibility                                                    |
| ---------------------------------- | ----------------------------------------------------------------- |
| [core](../src/core/)               | Errors, Result, i18n, IoC, plugin contracts, logging and policies |
| [persistence](../src/persistence/) | Mongoose schemas and repository interfaces/implementations        |
| [infra](../src/infra/)             | Discord helpers, MongoDB connections, HTTP and provider adapters  |
| [handlers](../src/handlers/)       | Commands, buttons, modals, select menus and reactions             |
| [plugins](../src/plugins/)         | Feature logic, subscriptions and scheduled jobs                   |
| [bot](../src/bot/)                 | BaseBot, personality composition roots and service tokens         |

ESLint enforces dependency boundaries. Core cannot depend on application layers;
handlers and plugins are siblings and cannot import each other. Shared Discord
helpers belong in `infra`. Plugins cannot import `@core/ioc` or personality roots.
They use the plugin context to resolve services.

The [token catalog](../src/bot/tokens.ts) and
[guild lookup port](../src/bot/guild-registry.ts) are deliberate exceptions:
plugins may import these composition contracts because their types reference
infrastructure and repositories that cannot live in core.

`scripts/` owns build and deployment tooling and cannot be imported by `src/`.
`tools/` owns operator workflows, including database maintenance and host migration.

## Startup and shutdown

[BaseBot](../src/bot/index.ts) owns the lifecycle; personality subclasses select
plugins with `this.use(...)`.

1. Bootstrap loads and validates the personality's environment and creates its client.
2. BaseBot builds the container, logger, translator, router and process safety handlers.
3. Plugin `init` hooks run before Discord login.
4. After login, plugin `start` hooks and the event bridge are attached before
   the deferred Discord-ready work is released.
5. Ready processing registers guilds, connects repositories, registers handlers
   and runs plugin `onReady` hooks.

Guild assembly, event routing and database connection work are delegated to
`GuildRegistrar`, `ClientEventBridge` and `GuildDbConnector`. Guild connection
failures are isolated; transient failures can recover in the background and
notify plugins through `onGuildDatabaseReady`.

A rejected startup exits with failure. Signals trigger bounded graceful shutdown;
a second signal exits immediately. Shutdown runs plugin cleanup, detaches event
subscriptions and closes resources. Client connection errors are logged while
discord.js reconnects. Only a narrow class of transient network errors is tolerated
at the uncaught-exception boundary; it must not be widened to the general retry policy.

When deployment supplies `BOTFLEET_READY_FILE`, BaseBot publishes an atomic
startup marker after Discord, guild repositories and plugins are ready. Disabled
plugins prevent readiness. This attests startup, not continuous health; database
recovery and reconnection can retry publication. See [deployment](contributing/deployment.md).

## Plugins and dependency injection

The manual typed [ServiceContainer](../src/core/ioc/) uses `ServiceToken<T>` and
singleton bindings. Per-guild state is accessed through explicit factories and
registries rather than container scopes. Handlers use BaseBot's typed accessors;
plugins resolve the same instances through their context.

| Hook                   | Purpose                                                                    |
| ---------------------- | -------------------------------------------------------------------------- |
| `init`                 | Initialize services; the only phase allowed to call `ctx.registerInstance` |
| `start`                | Attach listeners and start background work                                 |
| `onReady`              | Work requiring registered guilds and a ready Discord client                |
| `onGuildDatabaseReady` | Restore only the recovered guild's database-dependent jobs                 |
| `onShutdown`           | Release resources, in reverse registration order                           |

Plugin factories validate and capture their own configuration. Hook failures
disable the affected plugin while the host continues. Shutdown still cleans up
disabled plugins and removes their subscriptions. HTTP-owning plugins use bounded
server shutdown so idle connections cannot block process termination.

Plugins do not register handlers. Generated registries are the single registration
mechanism; features with both event and command entry points adapt the same services
through typed dependencies. See [Adding a plugin](contributing/adding-a-plugin.md).

## Interaction request flow

```text
discord.js event
  -> ClientEventBridge
  -> InteractionRouter and middleware
  -> generated handler registry
  -> handler index.ts
  -> service / repository / external adapter
```

The router dispatches commands and components; component routing uses the leading
custom-ID segment. Reaction handlers inspect each reaction themselves.
`npm run handlers:gen` updates registries; CI checks for drift.

Autocomplete uses the command's optional hook and returns bounded suggestions.
Failures produce an empty response and an operator log. Other handler errors reach
the router boundary, which maps domain errors into translated ephemeral replies.
Shared option parsing, error replies and paginated delivery live in `infra/discord`.

## Temporary moderation and automatic replies

When `/ban_user` falls back to deleting messages, its listener runs before
plugin message dispatch and synchronously marks each matching message to suppress
automatic replies. The `auto-reply` and `llm-auto-reply` plugins check that shared
marker before processing triggers or LLM requests. Suppression does
not wait for deletion to succeed, so a slow or failed Discord deletion cannot
trigger a reply. The listener checks the expiration time on each message, even
if timer cleanup is delayed.

The fallback belongs to the invoking bot client and target guild. See
[temporary moderation](contributing/operations.md#temporary-moderation) for
operator behavior and restart limitations.

## Persistence and external services

[Repositories](../src/persistence/repositories/) expose interfaces backed by
Mongoose; `buildRepos(connection)` creates the bundle for one guild. Tests can
inject fakes. Operational failures return `Result<T, DatabaseError>`; a missing
record is a successful empty result, while invalid programmer arguments throw.

[MongoConnectionManager](../src/infra/mongo/connection-manager.ts) manages pooled
connections, bounded retries and disabled guilds. Shutdown drains in-flight opens
so late connections cannot escape cleanup. See [database recovery](contributing/operations.md#database-recovery)
and the [persisted-model recipe](contributing/persisted-models.md).

External adapters translate SDK failures into domain errors. Provider strategies
keep platform-specific behavior outside feature logic:

| Adapter                                    | Selection and responsibility                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| [LLM](../src/infra/llm/)                   | Select OpenAI, Anthropic, Gemini or xAI per request; a separate client serves self-hosted replies |
| [Link preview](../src/infra/link-preview/) | Select providers for supported URLs and resolve preview media                                     |
| [Social feed](../src/infra/social-feed/)   | Resolve a configured platform by ID; normalize accounts, order post IDs and fetch timelines       |

Feed subscriptions store their filter and cursor together per platform/account/channel.
The poller groups subscriptions across guilds to read each account once per pass,
using the oldest applicable cursor, while delivery and cursor advancement remain
per subscription. Cursors advance only after successful Discord delivery.
Post IDs remain strings to avoid loss of precision.

## Errors, logs and localization

`DomainError` subclasses carry an error code, translation key, parameters and
original cause. Use cases return `Result` for expected failures; boundary adapters
translate external errors. Bounded retry classification is broader than the
process-level whitelist for tolerating uncaught network errors.

Pino logs carry a bot binding and optional guild context. The file sink routes
JSON Lines to `logs/<bot>[/<guildId>]/<localDate>.log`; plain test loggers do not
write files. High-volume message-create and reaction events are not audit-logged.

User-facing strings use the `commands`, `errors` and `replies` catalogs in
[src/i18n/locales](../src/i18n/locales/). English and Traditional Chinese keys must
stay aligned. CI scans handlers, plugins, bot and infra for CJK literals. The
guild-event mirror is an English operator audit surface rather than translated
user copy. See [Adding a command](contributing/adding-a-command.md) for i18n usage.

## Privacy-aware data commands

[PermissionRankPolicy](../src/core/plugin/permission-rank-policy.ts) supplements
Discord permissions with operator-defined channel ranks and member clearance.
Effective channel rank includes full ancestry. Invalid configuration fails startup;
unknown ancestry must not widen access. The policy is built once from static config.

Commands exposing aggregate guild data must preserve these rules:

1. Include only channels passing **both** the invoker's Discord `ViewChannel`
   check and the rank ceiling. Resolve the invoking member's roles and permissions.
2. Public replies cap visibility at `min(userRank, commandChannelRank)`;
   ephemeral replies cap at `userRank`.
3. Gate the invoker, not the report's subject. Unknown/deleted channels are excluded.
4. Filter before aggregation, using the same channel set for every statistic,
   including comparisons with earlier periods.
5. Keep empty results and labels neutral; do not reveal that hidden channels exist.

The `/traffic*` commands implement this pattern. Chart rendering uses the bundled
CJK font and strips unsupported emoji from canvas labels; Discord embeds retain them.

Feed commands use Discord visibility checks without rank gating. Subscription
changes and listings must fail closed when channel/member visibility cannot be
resolved; thread checks use the parent. Whole-channel removal rechecks access at
confirmation, and subscribing also checks the bot's ability to post.

Rank gates control Discord disclosure, not host storage. Event logs and deleted
attachments may contain private-channel data, and the attachment cache includes
recent undeleted files. Storage behavior and retention settings are documented in
[Configuration](configuration.md#attachment-storage).

## Deployment boundary

The runtime launcher selects the project Conda environment. Deployment creates
independent systemd units and snapshots source/dependencies into releases while
configuration, logs and data remain shared. A transaction journal supports rollback
and recovery; MongoDB has a separate runtime and data lifecycle. See the
[deployment guide](contributing/deployment.md) for commands and rollback limits,
and the [migration runbook](../tools/migration/README.md) for host transfers.
