# Architecture

A single-page snapshot of the BotFleet codebase: how the layers
fit together, what the key abstractions are, how a Discord interaction
flows through the system, and how plugins are wired in.

For day-to-day contribution recipes (adding a command, adding a plugin,
running the quality gates) see `[CONTRIBUTING.md](../CONTRIBUTING.md)`.

---

## 1. Layering

The codebase is split into six layers. Dependencies flow strictly
downward; ESLint `no-restricted-imports` rules enforce the direction.

```
            bot/         composition roots — one per personality
              |
              v
   handlers/     plugins/        feature surface
              |
              v
    persistence/   infra/        adapters to external systems
              |
              v
            core/               pure domain — no Discord, no Mongo
```

| Layer         | Path               | Allowed to depend on           | Examples                                                             |
| ------------- | ------------------ | ------------------------------ | -------------------------------------------------------------------- |
| `core`        | `src/core/`        | nothing outside `core`         | `errors`, `result`, `i18n`, `ioc`, `plugin`, `logger`, `time`        |
| `persistence` | `src/persistence/` | `core`                         | Mongoose schemas + Repository interfaces and implementations         |
| `infra`       | `src/infra/`       | `core`                         | `MongoConnectionManager`, LLM provider strategies                    |
| `handlers`    | `src/handlers/`    | `core`, `persistence`, `infra` | slash command / button / modal / select-menu / reaction entry points |
| `plugins`     | `src/plugins/`     | `core`, `persistence`, `infra` | self-contained feature modules                                       |
| `bot`         | `src/bot/`         | everything above               | `BaseBot`, per-personality subclasses, the token catalog             |

Plugins reach `core` only through the `@core/plugin` barrel; importing
`@core/ioc` directly from `src/plugins/**` is ESLint-forbidden so the
IoC container's write face stays inside the composition root.

Two modules under `src/bot/` are the exception to the arrow direction:
[`tokens.ts`](../src/bot/tokens.ts) (the service-token catalog) and
[`guild-registry.ts`](../src/bot/guild-registry.ts) (the per-guild
lookup port). Both name concrete `infra` / `persistence` types, so
`core` — which may depend on nothing outside itself — cannot host them;
they belong to the composition root, and plugins import them directly.
The personality composition roots (`src/bot/<name>/**`) stay off-limits
to plugins, which ESLint enforces.

`scripts/` sits outside the table and outside the dependency graph:
nothing under `src/` may import from it. Logic needed at both build time
(`src/deploy.ts`) and runtime (command registration) lives under
`src/handlers/commands/` and is consumed from both sides — for example
`buildCommandJsonBody`, whose input type is a handler-layer contract.

`tools/migration/` is an operational boundary outside the application layers.
Its Bash bootstrap prepares an empty target; dependency-free Node orchestration
then coordinates Git-ignored file inventories and external MongoDB tools.
Application code is obtained separately through Git clone.
It does not import application services or change database schemas. See the
[migration runbook](../tools/migration/README.md) for its configuration and workflow.

## 2. Key abstractions

### `BaseBot` ([src/bot/index.ts](../src/bot/index.ts))

Thin lifecycle owner. Subclasses (`nijika`, `konata`, `tomori`,
`msg-archive`) opt plugins in via `this.use(...)` and override
configuration; `BaseBot.run()` orchestrates startup in a fixed order:

1. Load env + build composition-root container.
2. Initialise the i18n translator (in the bot's configured `language`, default `zh-TW`) and load locale catalogs.
3. Connect every configured guild's MongoDB via the shared connection manager.
4. Resolve each guild's channels, roles, and repositories.
5. Attach the Discord client event bridge.
6. Run plugin `init` → `start` hooks in registration order.
7. Login to Discord, await `ClientReady`, run `onReady` hooks.

Three single-purpose collaborators back the orchestrator:

- `**GuildRegistrar**` ([src/bot/guild-registrar.ts](../src/bot/guild-registrar.ts)) — pure assembly of per-guild `GuildInfo` (channels, roles) from Discord cache + bot config. Best-effort; never throws.
- `**ClientEventBridge**` ([src/bot/client-event-bridge.ts](../src/bot/client-event-bridge.ts)) — adapter from `client.on(...)` raw events to the `InteractionRouter`, the plugin `EventDispatcher`, the reaction port, and the `GuildCreate` fallback. Owns a single attach/detach cycle.
- `**GuildDbConnector**` ([src/bot/guild-db-connector.ts](../src/bot/guild-db-connector.ts)) — per-guild Mongo lifecycle. Drives the `ReposFactory` and normalises failure into `ConnectionManager`'s disabled-set so other guilds keep running.

Two process-level safety nets are installed in step 1 (before login), so they span the client's whole lifecycle and are owned by `BaseBot` rather than the late-attaching `ClientEventBridge`:

- `installProcessHandlers` ([src/core/logger/process-handlers.ts](../src/core/logger/process-handlers.ts)) — owns three signals into the same graceful-shutdown path:
  - `SIGINT` / `SIGTERM` run `BaseBot.shutdown()` under a 5-second hard timeout and then exit 0. Installing a listener is what makes the graceful path reachable at all: with none, Node terminates immediately and leaves Mongo connections open, a half-written backup transcript, and a bound HTTP port. A **second** signal while a shutdown is in flight exits immediately — a second Ctrl+C means "stop waiting".
  - `uncaughtException` triggers the same shutdown and exits 1, **except** a transient network blip (`ECONNRESET` / "socket hang up", classified by [`isTransientNetworkError`](../src/core/errors/transient-network-error.ts)), which is logged and tolerated so a momentary outbound-socket reset cannot kill the process. The tolerance whitelist is deliberately narrow and must stay that way: after a genuine uncaught fault the process state is indeterminate, so broadly declining to exit on `uncaughtException` would mask real defects rather than absorb a blip.
  - `unhandledRejection` is logged and counted, never fatal.

  A single re-entrancy guard covers all three, so concurrent triggers arm one timer and one teardown.

- `installClientSafetyListeners` ([src/bot/client-safety-listeners.ts](../src/bot/client-safety-listeners.ts)) — attaches non-fatal `error` / `shardError` / `shardDisconnect` listeners to the Discord client. Without an `error` listener Node rethrows an emitted client error as an `uncaughtException`; this keeps a gateway socket reset observable while discord.js reconnects on its own. Those connection failures (a socket reset, a handshake timeout, a DNS miss) are logged at `warn`, not `error`, because they are expected and self-healing and must not trip an alert keyed on the error level. The recovery side — `shardReconnecting` / `shardResume` / `shardReady` — is logged at `info`, so the log shows that the bot came back and not only that it dropped. Idempotent per client, so a repeated install cannot multiply every logged line.

Startup failure is terminal. Each personality entry point starts the bot through `bootstrapPersonality` ([src/bot/bootstrap.ts](../src/bot/bootstrap.ts)), which loads the personality's `.env`, validates it into a typed `Env`, builds the Discord client from the requested gateway intents, and hands the bot to `runOrExit` ([src/bot/run-or-exit.ts](../src/bot/run-or-exit.ts)). `runOrExit` exits 1 when `run()` rejects: a detached `run()` leaves a live process with no commands registered and no reason for a supervisor to restart it.

Everything handlers and bridges read off a live bot goes through a typed accessor — `getRepos`, `guildRegistry`, `jobMap`, `permissionRankPolicy`, `connectionManager`, `modelCatalog`, `feedPlatformRegistry`, `requireLogger()`. Each resolves the container binding a plugin would reach through `ctx.resolve(TOKENS.X)`, so both sides of a feature observe one instance rather than two parallel copies.

### Plugin contract ([src/core/plugin/](../src/core/plugin/))

A `Plugin` declares:

- `id` and a SemVer `version`. `id` must be unique per host; that is the only register-time check.
- Lifecycle hooks: `init`, `start`, `onReady`, `onShutdown`. `init` is the only phase allowed to publish singletons via `ctx.registerInstance(token, instance)`. `onShutdown` runs in **reverse** registration order; failures are logged but never fatal. Shutdown ignores disabled status: a plugin disabled during `onReady` has already opened whatever `start` opened and still holds live event subscriptions, so both its `onShutdown` and its `unsubscribeAll` run. Teardown is best-effort by contract, which is what makes running it unconditionally safe.
- Event subscriptions over discord.js `ClientEvents`.

Configuration is **not** part of the contract. Each plugin factory
parses its own raw config with a `parse<X>Config` function at
composition time and captures the result in the returned object's
closure, so a malformed block fails the boot rather than the first
event — and the parsed shape stays private to the plugin instead of
travelling through the host as an `unknown`.

Handler registration is not part of the contract either: the codegen
registries under `src/handlers/<type>/registry.generated.ts` are the
single registration mechanism. A plugin whose feature also has slash
commands therefore has two entry paths into the same internals: its own
lifecycle hooks, which take dependencies from `ctx.resolve`, and the
handler layer, which arrives holding a `BaseBot`. The second path is
adapted in one place per plugin — `internal/deps-from-bot.ts`, which
builds the same dependency bundle out of `BaseBot`'s typed accessors.
Keeping it in its own file also stops a test that imports the plugin
from pulling `BaseBot` (and the whole handler layer behind it) into the
compile.

`PluginHost` ([src/core/plugin/host.ts](../src/core/plugin/host.ts))
walks every phase in registration order and fans `Promise.allSettled`
across event subscribers. Failure isolation is total: a hook that
throws moves its plugin into the disabled set and the phase carries on,
so no plugin can abort startup.

### IoC container ([src/core/ioc/](../src/core/ioc/))

A small manual `ServiceContainer` typed via `ServiceToken<T>`. There is
no `reflect-metadata` and no DI framework. The surface is
`registerSingleton` / `resolve` / `tryResolve`: singleton is the only
lifetime, because every service the bot binds is process-scoped and
per-guild state is reached through an explicit factory token
(`ReposFactory`) rather than a container scope.

`core/ioc` owns the mechanism only. The catalog of what gets bound
lives with the composition root at
[src/bot/tokens.ts](../src/bot/tokens.ts) — naming `ConnectionManager`,
`Repos` and friends inside `core` would invert the
layer arrows. Plugins import `TOKENS` from there and reach the
container itself through nothing but `ctx.resolve`, a typed-token
accessor.

### Structured logging ([src/core/logger/](../src/core/logger/))

`createLogger` builds the pino instance and an optional pretty console;
the file sink is a separate opt-in factory (`createFileSink`) wired in
by `createBootstrapLogger`, the composition-root logger factory. The
file router writes JSON Lines to
`<rootDir>/<botId>[/<guildId>]/<localDate>.log`, rotating on the
local-time day boundary. Tests build loggers through plain
`createLogger` and therefore never touch the filesystem.

Two contracts are load-bearing:

- **Every record reaching the file sink must carry the `bot` binding.**
  The composition root attaches `{ bot: clientId }` on the root logger;
  a missing binding is a contract violation that surfaces as an error
  on the `Writable` stream, deliberately rather than landing in a
  fallback directory. `bot` is path-encoded only — the routing step
  strips it from the record before serialising, while `guildId` stays in
  so cross-guild aggregators can join on it. A one-shot CLI with no
  `bot` binding that must not create a `logs/` tree — `src/deploy.ts` —
  opts out with `createBootstrapLogger(base, { fileRouter: false })`,
  the only console-only escape.
- **Reaction events and `MESSAGE_CREATE` are intentionally not
  audit-logged.** Per-guild throughput on the hot reply path would
  drown every other event; the plugin reply behaviour itself is
  unaffected.

### Repository pattern ([src/persistence/repositories/](../src/persistence/repositories/))

Each persistent entity has an `<X>Repo` interface and a `Mongo<X>Repo`
implementation. `buildRepos(connection)` returns the `Repos` bundle
bound to one guild's Mongo connection. Handlers and plugins depend on
interfaces; tests inject in-memory fakes.

Every repository method returns `Result<T, DatabaseError>`, and the
boundary between a domain failure and a bug is explicit:

- A successful lookup that finds nothing is `ok(undefined)`, not an
  error. Mongoose failures are translated by `databaseErrorFrom` into
  `err(databaseError)`, and `insertManyIgnoringDuplicates` treats a
  duplicate-key `BulkWriteError` as `ok`.
- **Programmer errors never enter `Result`.** A non-positive `limit` or
  a malformed timestamp range throws a native `TypeError` — those are
  bugs at the call site, not outcomes a caller should branch on.

Schemas may not import infra-layer constants for their defaults; the
dependency direction forbids it. Where a schema needs a seed value that
infra also owns (the xAI-first model id in `user-api-setting`), the
schema holds a static literal as a safety net and the authoritative
value is resolved at runtime.

### i18n ([src/core/i18n/](../src/core/i18n/) + [src/i18n/locales/](../src/i18n/locales/))

`Translator` wraps i18next. Catalogs live at
`src/i18n/locales/<lang>/{commands,errors,replies}.json` keyed
`<namespace>:<feature>.<purpose>`. The `localesDir` is injected from
the composition root so `core/i18n` has no knowledge of the content
layer's path. Each personality picks its default locale through its
`config.json` `language` field (`'zh-TW'` | `'en'`), validated by
`isLocale` and threaded into `createDefaultTranslator({ fallbackLocale })`;
an unsupported value falls back to `DEFAULT_LOCALE`. CJK literals are
forbidden inside `src/handlers/`, `src/plugins/`, `src/bot/`, and
`src/infra/`; a CI scanner enforces this. The scanner treats fullwidth
CJK punctuation (`U+3000–U+303F`, `U+FF00–U+FFEF`) as CJK too, because a
fullwidth `：` reads as Chinese copy even in an otherwise-Latin string.
`src/infra/` is in scope because an adapter that formats text for a
Discord reply must take the already-translated string from its caller —
`formatUsageFooter` takes its "unknown model pricing" label as an
argument rather than inlining one locale's wording.

One surface is deliberately outside the catalog: the `guild-events`
mirror channel. Its embeds (message edited / deleted, member updated)
stay in English because the `event` channel is an **operator surface**,
not a user-facing one — it is read by whoever administers the guild,
alongside the structured log lines it mirrors, and those are English.
Translating it would split one audit trail across two languages. Do not
"fix" the missing keys.

### Error taxonomy + Result ([src/core/errors/](../src/core/errors/), [src/core/result/](../src/core/result/))

`DomainError` is the root of the taxonomy: `ConfigurationError` and the
`ExternalServiceError` branch (`DatabaseError`, `LlmProviderError`,
`LinkPreviewError`, `FeedError`). Every error carries `code`,
`messageKey` (i18n), `messageParams`, and the original `cause`.
Dispatch is by `instanceof` — there is no discriminant string field,
because a parallel tag can only drift out of sync with the class
hierarchy. A new subclass is added when a real boundary needs one, not
speculatively. Use cases prefer `Result<T, DomainError>`; error-translator
modules at each infra boundary turn SDK failures into domain errors.
Alongside the taxonomy, [`isTransientNetworkError`](../src/core/errors/transient-network-error.ts)
classifies a raw, unwrapped `Error` as a transient connectivity blip
(a narrow whitelist of socket error codes plus Node's "socket hang up"
message) — used by the process-level safety net to tolerate a momentary
network reset instead of crashing.

`isRetryableError` ([src/core/retry/](../src/core/retry/)) answers a
different question and is deliberately broader: transient 5xx / 429
responses, `ConnectTimeoutError` / `AbortError` / `FetchError`, the OS
socket and DNS errno codes a lost route or a dropped peer produces
(`EHOSTUNREACH`, `ENETUNREACH`, `ECONNREFUSED`, `ECONNRESET`, …), and
undici `UND_ERR_*` codes all justify a bounded retry. **The two
predicates must never be widened into each other.** A retry is cheap;
tolerating an uncaught exception is not, so a code that belongs in one
list does not automatically belong in the other — the socket codes the
two lists share are each maintained in place. A caller may pass
`shouldRetry` to _narrow_ `isRetryableError` — `social-feed` does, to stop
retrying a 429 against a shared host whose rate-limit budget it does not
own — or pass `maxAttempts` / `initialDelayMs` to stretch the budget:
`message-backup` runs unattended, so its walker waits out an outage of
several minutes before it gives up on a channel.

### Branded IDs ([src/core/ids.ts](../src/core/ids.ts))

`GuildId` and `ChannelId` are branded strings so a `ChannelId` cannot be
passed where a `GuildId` is expected. Only the two ids the data layer
actually keys on carry a brand; one per Discord snowflake would buy
nothing but noise at every call site.

### `PermissionRankPolicy` ([src/core/plugin/permission-rank-policy.ts](../src/core/plugin/permission-rank-policy.ts))

Operator-defined privacy / clearance ranking for channels and users —
orthogonal to Discord's own permissions. Each guild's `config.json`
carries a `permission_rank` block: channels and roles get a non-negative
integer rank (higher = more private; a member's clearance is the max over
their ranked roles), and each rank-gated feature has a `maxChannelRank`
ceiling. A feature suppresses a channel when its effective rank — the max over
the channel and its full ancestry (parent channel → category, so a private
category lifts every channel and thread nested under it) — exceeds the ceiling.
For `guild-events` this gate is **disclosure-only**: an edit/delete above the
ceiling is withheld from the Discord `event` channel, yet still written to the
local structured log and its attachments archived, regardless of rank. That is
a deliberate privacy trade-off, not an oversight: the rank system governs
Discord-side disclosure, while the host is an unconditional sink, so
private-channel message content lands in `logs/<bot>/<guildId>/<date>.log` and
deleted attachments in `./data/deleted_attachments/<guildId>/`. Anyone with
file-system access to the bot host can read them — treat host access as
equivalent to full channel access.

That sink now reaches wider still. Discord purges an attachment's CDN object
nearly synchronously with the message deletion, so downloading at
`messageDelete` — the original design — usually 404s on a URL whose signature
is still valid, and the archive stayed mostly empty. The fix is a **pre-delete
attachment cache** ([src/infra/discord/attachment-cache.ts](../src/infra/discord/attachment-cache.ts)):
`guild-events` downloads every non-bot guild attachment on `messageCreate`
into `./data/attachment_cache/<guildId>/<messageId>/`, and on deletion moves the
cached copy into the archive instead of racing the CDN — never overwriting an
existing archive file, since the archive name is timestamped only to the second
and a batch moved in one pass would otherwise collide with itself. The
consequence for
the note above is that a copy of **every recent attachment lives on disk**, not
only the deleted ones; an hourly TTL sweep (default 24 h, `guild_events.attachment_cache`)
bounds that window, and setting `enabled: false` restores the
download-on-delete-only behaviour. The cache is bounded on the disk axis too:
before each message it probes the cache volume with `statfs` and writes nothing
new while free space is under `minFreeDiskMb` (default 5 GiB), logging the pause
and the resume once each rather than once per attachment. That floor gates new
cache writes only — the delete-time paths (moving a cached file into the archive,
and the network fallback) run regardless, because declining to archive loses
evidence rather than deferring it. An unreadable volume fails open: the floor is
best-effort availability protection, not proof that a disk is full. `attachment-archive.ts` remains the fallback
for messages the cache never saw and retries once against `attachment.proxyURL`
(`media.discordapp.net`), whose cache often still holds recently displayed
media; a 404 on both ends is the expected race and logs at `info` rather than
`warn`. The
`channelRank` /
`userRank` / `visibilityCeiling` primitives let a visibility-gated feature —
realized by the `/traffic` commands — show channel `T` only when
`channelRank(T) <= ceiling`, combined with a native `ViewChannel` check for
the invoker (the dual filter, so an unconfigured rank map still never leaks a
Discord-private channel). The ceiling tracks the reply audience: a public
reply uses `visibilityCeiling = min(userRank, commandChannelRank)` (never
above the room's own rank), a private / ephemeral reply uses `userRank` alone. The policy is a core interface built once
from static config in the `BaseBot` constructor and registered under
`TOKENS.PermissionRankPolicy` (same seam as `GuildOnboardingPort`):
discord.js-free, fail-fast validated, resolved per-event by the `guild-events`
/ `social-link-preview` plugins and the channel-logging middleware, and
per-invocation by the `/traffic` / `/traffic_me` / `/traffic_user` handlers
through the `bot.permissionRankPolicy` accessor. It replaced the bot-wide `blocked_channels` list (suppression is now
per-guild).

### Privacy-aware data commands

A command that surfaces aggregated guild data (message counts,
rankings, traffic) must not reveal activity from channels the invoker
cannot see. `/traffic`, `/traffic_me`, and `/traffic_user` realise the
pattern on top of the `PermissionRankPolicy` primitives above; follow
it for any new one. The two per-user commands share one body in
`src/handlers/commands/traffic-shared/user-traffic-command.ts`,
so a third per-user report is a spec (`command` + `resolveSubject`),
not a fourth copy of the filter.

1. **Dual filter.** A channel's data is included only when it clears
   BOTH the operator-defined `permission_rank` ceiling AND the
   Discord-native `ViewChannel` check for the invoking member. Either
   one alone is insufficient: an unconfigured rank map must still never
   leak a Discord-private channel. Resolve the policy through
   `bot.permissionRankPolicy` (handlers never touch the container or
   `TOKENS`) and fetch the invoking `GuildMember` via
   `guild.members.fetch(...)` so `roles.cache` and permission
   overwrites are populated.
2. **The reply audience sets the ceiling.** A `public` reply is posted
   into the room, so it caps at
   `visibilityCeiling(guildId, roles, commandChannelId, ancestors)` =
   `min(userRank, channelRank(commandChannel))` — never above the
   command channel's own ancestry-aware rank. An `ephemeral` reply only
   the invoker sees caps at `userRank` alone. Either way the invoker is
   bounded by their own clearance.
3. **Gate the invoker, not the subject.** When a command reports on a
   named target, build the visible-channel set from the **invoker** and
   count the target's activity only within it, so the target's own
   clearance never widens the view. A target with no visible activity —
   including a non-member — must yield the same neutral no-data reply.
4. **Build the allowed set from the live cache and fail safe.** Walk
   `guild.channels.cache`; a channel present only in archived data
   (deleted or uncached) is never added. Each channel's effective rank
   is the max over its full ancestry, so a ranked category gates every
   channel and thread beneath it. Apply the filter _before_ aggregation
   so an excluded channel contributes nothing.
5. **Every derived statistic uses the filtered set — including
   cross-window ones.** A "change vs previous period" trend must
   re-count the preceding window through the _same_ allowed set, or the
   comparison leaks an unseen channel's volume.
6. **Keep the copy neutral.** Option labels and the empty-result
   message must not hint that restricted channels exist (`visibility`
   choices read "Only you" / "Everyone", not "your full clearance
   view"), so a low-clearance user cannot infer higher-clearance
   channels from the wording.
7. **Split emoji by surface.** The chart font has no emoji glyphs, so
   `stripEmoji` (`traffic-shared/chart-common`) removes them from every
   canvas label and header, falling back to the original when stripping
   would empty the label. Discord-native **embed** text keeps its
   emoji, rendering a custom emoji as its `<:name:id>` (animated
   `<a:…>`) token and a unicode one as the character itself.

When an embed builder outgrows the 150-line cap, split it into a
sibling file rather than thinning the privacy logic.

A lighter relative of the pattern governs the `/feed_*` subscription
commands. They aggregate nothing and are not rank-gated, so only the
Discord-native half applies: **authority is ungated — any member may
subscribe or unsubscribe — but reach is not.** `/feed_subscribe` and
`/feed_unsubscribe` refuse a destination channel the invoker cannot
`ViewChannel` (checked against the parent for a thread), and `/feed_list`
resolves each row's channel the same way — a thread through its parent —
then drops every row the invoker cannot see, without hinting that any
were withheld. A row whose channel or invoking member cannot be resolved
from the cache is dropped too: for a filter whose job is to withhold,
"unknown" must fail closed. Without that bound, ungated authority would let any
member push content into, or quietly empty, a channel that is closed to
them. `/feed_unsubscribe` applies that check twice — once when it
proposes clearing a whole channel, and again on the button that
confirms, by which time the invoker's access may have been revoked — so
it reads the rule from `gateFeedChannel`
([src/handlers/feed-channel-gate.ts](../src/handlers/feed-channel-gate.ts))
rather than repeating it, as does `/feed_subscribe`; `/feed_list`
applies the same rule per row while filtering.
`/feed_subscribe` additionally refuses a channel the **bot** cannot
post in, which is a usability check rather than a privacy one: the
subscription would otherwise fail silently on every pass.

### `MongoConnectionManager` ([src/infra/mongo/connection-manager.ts](../src/infra/mongo/connection-manager.ts))

Process-wide pool keyed by URI, shared across personalities. Owns
per-guild connection lifecycle, exponential-backoff retry, and the
disabled-set that lets the bot keep serving other guilds when one
guild's database is unreachable.

`closeAll` is generation-guarded: it bumps a counter, drains the
in-flight opens, and any open that completes afterwards discards its own
connection instead of entering the cache. `closeAll` can only close what
it can see, so a late arrival cached behind its back would be a socket
no later teardown knows about.

### LLM Strategy ([src/infra/llm/](../src/infra/llm/))

Four providers (`Anthropic`, `OpenAI`, `Gemini`, `xAI`) implement a
single `LLMProvider` interface and translate their SDK errors into
`LlmProviderError`. `LLMService` selects a provider per request;
`ModelCatalog` lists supported models and is published to the
container by `LlmChatPlugin` under `TOKENS.ModelCatalog`.

Two of the four speak the same wire protocol, so `OpenAIProvider` and
`XAIProvider` are Template Method subclasses of
[`OpenAICompatibleProvider`](../src/infra/llm/openai-compatible-provider.ts),
each contributing only a spec: its name, its `baseURL`, and the
web-search tool its Responses API expects. Anthropic and Gemini have
their own SDK shapes and stand alone.

`SelfHostedLlmClient` (`selfhosted-client.ts`) is a separate outbound
adapter in the same layer for a lightweight self-hosted LLM endpoint. It
does not implement `LLMProvider` (the endpoint's request/response shape
and the absence of an API key / model differ), but it maps failures into
the same `ExternalServiceError` taxonomy and returns a `Result`. Consumed
by the `LlmAutoReplyPlugin`.

### Link-Preview Strategy ([src/infra/link-preview/](../src/infra/link-preview/))

A second Provider Strategy, mirroring the LLM layer, for the
`SocialLinkPreviewPlugin`. Each `LinkPreviewProvider` matches a URL
(`canHandle`) and `build`s a `LinkPreviewResult` — a discriminated union
of `rewritten-url` (an embed-proxy link Discord unfurls into a playable
video) and `card` (neutral OpenGraph data the plugin renders into a
static embed). The six rewrite providers (Twitter/X, Instagram, Threads,
Facebook, Reddit, Bilibili) are mostly pure host-swaps, but Facebook,
Bilibili, and Threads are composed providers that first expand an opaque
short link (`facebook.com/share/<token>` / `fb.watch`, `b23.tv`,
`threads.com/share/<token>`) to its canonical permalink before probing
the proxies — the first two via `OgClient.resolveCanonical`, which
returns the URL the redirect chain lands on, Threads via
`OgClient.resolveRedirectChain`, because Threads rejects the consumed
share token on the follow-up request and bounces the chase to an error
page, leaving the permalink reachable only as an intermediate hop;
`bahamut` scrapes OpenGraph via the SSRF-safe
`OgClient` (streamed, bounded redirect-following behind a `beforeRedirect`
SSRF guard, host allow-list, and a bounded c-ares name lookup so a proxy
whose name servers have died costs one short DNS timeout instead of
holding a libuv threadpool thread that every other lookup in the process
then queues behind).
Failures map into `LinkPreviewError`. `LinkPreviewProviderRegistry`
matches by URL in registration order. The per-source proxy-host lists are
operator configuration (the bot's `social_link_preview` block), not code
defaults — embed-proxy domains change availability faster than releases
ship — and each host is probed and ranked before anything is posted
(`video > image > weak-image > text`), so a dead or media-less proxy ends
in a silent skip rather than a bare link. A host whose probe is finally
served from the source site itself is skipped before ranking: the proxy has
redirected back to instagram.com or x.com, so the metadata read there is
what the source serves the bot host, while Discord's crawler would follow
the same redirect from its own address and render only a login wall. A message deleted while its
preview was being built ends in the same silent skip: Discord rejects the
reply's `message_reference`, and the plugin treats that as the author
withdrawing the link, not as a fault.

### Social-Feed Strategy ([src/infra/social-feed/](../src/infra/social-feed/))

A third Provider Strategy, for the `SocialFeedPlugin` and the `/feed_*`
commands, following the same shape as the two above. A `FeedPlatform`
owns everything one social network spells differently: canonicalising an
account handle (`normalizeAccount`), reading a timeline
(`fetchTimeline`), ordering two post ids (`compareIds`), deriving the
id floor a post created "now" would carry (`baselineIdAt`, the fallback
anchor when a first read yields nothing the platform can order), and
producing the link Discord can unfurl (`toEmbedUrl`). What comes back is
a platform-neutral `FeedPost` (`id`, `authorAccount`, `createdTimestamp`,
`url`, `text`, `isReply`, `isRepost`, `media[]`); the plugin owns all
Discord assembly and all filtering, so no platform-specific arithmetic
leaks upward. `FeedPost.id` stays a **string**: X post ids are 64-bit and
exceed `Number.MAX_SAFE_INTEGER`, so ordering goes through the platform's
own `compareIds` rather than `Number`.

`FeedPlatformRegistry` looks a platform up by id and is built by each
composition root from its `social_feed.platforms` block, then published
under `TOKENS.FeedPlatformRegistry`. The poller and the subscription
commands share that one instance, so an account accepted by
`/feed_subscribe` is exactly one the next pass can read. A platform the
operator did not configure is simply absent, and the caller renders the
refusal.

`/feed_unsubscribe` suggests accounts for its `account` option through
the autocomplete hook described in §3. The suggestions come from the
target channel's stored subscriptions — never from the upstream, which
could not answer inside the three-second window and has nothing to say
about what this guild subscribed. They are gated by the same
`ViewChannel` check the command and its confirmation button share, so a
channel the invoker cannot see yields none, and completion applies to
the last comma-separated segment so accepting one extends the list
instead of replacing it.

The shipped `XPlatform` wraps `FxTwitterTimelineSource`, which reads an
FxTwitter-compatible JSON API — chosen because X's official API has no
free tier and bills per post read, which a five-minute poller cannot
justify. The Strategy, an operator-configurable `apiBaseUrl` (so a
self-hosted instance can replace the public host), and a
default-disabled plugin together absorb the risk of depending on a
community-run upstream.

What is followed is not configuration: `FeedSubscriptionRepo`
(`src/persistence/`) stores one document per `(platform, account,
channel_id)` triple — its unique index — holding the subscription, its
filter, and its polling cursor together. Cursor and subscription share a
lifetime, so removing a subscription cannot orphan cursor state and
nothing has to be reconciled at boot. Re-running `/feed_subscribe` on an
existing triple is an update, not a conflict, and it **replaces the
filter wholesale**: an omitted `keyword` clears a stored one, while
`created_by` and the cursor are preserved. Because that replacement is
silent from the member's side, every success line in the reply names the
filter now in force, in the same words `/feed_list` uses for it.

`/feed_subscribe` and `/feed_unsubscribe` both take a list of accounts
in one invocation, parsed by one shared rule so the two commands cannot
disagree about what a member typed. The list is capped, because each new
subscription costs one upstream read. Subscribing then gates the
destination channel **once** and processes the accounts sequentially,
each independent: an unusable handle or an upstream refusal costs that
account only, and the reply reports every account as created, updated,
failed with its reason, or not attempted.

Two things end a batch early rather than isolating. A **systemic**
failure — rate limited, database down — is a property of the batch, not
of the account that met it, so continuing would only repeat the same
error at an upstream that just asked to be left alone. And the batch
holds a **time budget** measured from the interaction: Discord expires a
deferred interaction after fifteen minutes, and a report that cannot be
delivered would leave a member with subscriptions written and nothing on
screen. The cap bounds the common case; the budget is what makes the
worst case safe. Because per-account failures never reach the handler's
error boundary, each is written to the operator log where it is
absorbed, and one further line records the batch as a whole.

Unsubscribing is the opposite shape — one query with an `$in` over the
named accounts — and refuses the whole call if any entry is unusable,
since a partial deletion would make a typo indistinguishable from an
account that was never subscribed. An empty account list matches
nothing rather than widening: "remove nothing" must never become
"remove everything".

Clearing a **whole channel** — naming neither a platform nor an account
— is the one scope that deletes nothing on sight. It counts what the
channel holds and answers with that number plus two buttons; only the
Danger one deletes. The receipt that used to follow the deletion was a
record, not an undo, and the widest scope is also the easiest to reach
by accident, since it is what a member gets by filling in no option at
all. The buttons carry the channel and the asking member in their
customId and the confirm handler
([src/handlers/buttons/feed_clear_confirm/](../src/handlers/buttons/feed_clear_confirm/))
trusts neither: it re-resolves the guild's repositories, re-runs
`gateFeedChannel`, and reports what it actually removed rather than the
count it promised. A narrowed scope still applies immediately — it names
what it removes, so there is nothing to confirm.

Two tiers of rule decide what a pass forwards. The **hard rules** hold
whatever a subscription asks for: only the followed account's own
original posts go out, so a reply (including a self-thread continuation)
and a repost of someone else's post are never forwarded. Only on top of
those does the subscription's own `media` / `keyword` filter narrow
further, its defaults reproducing the historical media-only behaviour.

Failures map into `FeedError`, whose taxonomy also carries the two
non-upstream refusals the commands raise (an unusable account handle,
an unconfigured platform) so one feature keeps one `errors:feed.*`
catalog section.

## 3. Interaction request flow

```
discord.js event
   |
   v
ClientEventBridge          (src/bot/client-event-bridge.ts)
   |   .on('interactionCreate')
   v
InteractionRouter          (src/core/plugin/interaction-router.ts)
   |   Chain of Responsibility
   |   - subclass middleware (optional)
   |   - createDispatchMiddleware  (incl. autocomplete)
   |   - createChannelLoggingMiddleware
   v
Generated registry         (src/handlers/<type>/registry.generated.ts)
   |   key = command / customId / componentId
   v
Handler index.ts           (src/handlers/<type>/<name>/index.ts)
```

Buttons, modals, select menus and reactions are four instances of one
shape, so each family's barrel is a spec (its generated registry, the
noun its log lines use, and how its handler map is published on the bot)
handed to the builders in
[src/handlers/index.ts](../src/handlers/index.ts). Registration is
best-effort — a throwing handler constructor disables that family and
leaves the rest of the bot serving — and dispatch routes on the leading
`<type>` segment of `customId`. Reactions carry no customId, so every
registered reaction handler sees every reaction and decides for itself.

An autocomplete interaction takes the same route to a different verb.
Dispatch routes it to `executeAutocomplete`
([src/handlers/commands/autocomplete.ts](../src/handlers/commands/autocomplete.ts)),
which asks the named command's optional `autocomplete` hook for
suggestions, bounds them to Discord's limits (25 choices, 100 characters
per field) and answers with `respond`. The hook returns a list rather
than sending one, and every failure — unknown command, no hook, a hook
that threw, a `respond` past the three-second window — resolves to an
empty list plus an operator log line, because this is the one
interaction kind that cannot be replied to and so cannot report a
failure to the member.

Middleware lives in [src/bot/middlewares.ts](../src/bot/middlewares.ts).
Handler-thrown `DomainError`s are caught at the router edge and
rendered via `replyTranslated` ([src/handlers/reply-translated.ts](../src/handlers/reply-translated.ts) and
[src/infra/discord/reply-for-error.ts](../src/infra/discord/reply-for-error.ts)) as
i18n-aware ephemeral replies.

`handlers` and `plugins` are **sibling** layers, so neither may import
the other — and three plugins own Discord interaction bodies of their
own (`giveaway`, `activity`, `temp-role`). The utilities both need
therefore live one layer down, in `infra/`: option reading
([src/infra/discord/options.ts](../src/infra/discord/options.ts)),
error-to-reply mapping with the shared `traceId`
([src/infra/discord/reply-for-error.ts](../src/infra/discord/reply-for-error.ts)),
per-page-isolated delivery of a listing too long for one message
([src/infra/discord/send-paged-reply.ts](../src/infra/discord/send-paged-reply.ts)),
and the bounded outbound HTTP client
([src/infra/http/](../src/infra/http/)). An ESLint
`no-restricted-imports` rule fails the `plugins -> handlers` direction so
the edge cannot silently return.

The registry files are produced by
[scripts/gen-registry.ts](../scripts/gen-registry.ts); a drift check
(`yarn handlers:gen:check`) fails CI if the directory tree and the
generated registry disagree.

## 4. Plugin lifecycle

Plugins are processed in registration order — the order each
personality's constructor calls `this.use(...)`:

1. `**init**` — runs before Discord login. The only phase where a
   plugin may publish a singleton via
   `ctx.registerInstance(token, instance)`. Reads config and bootstraps
   collaborators.
2. `**start**` — runs after `init` but before `ClientReady`. Attaches
   subscriptions, registers low-frequency listeners, schedules jobs.
3. `**onReady**` — runs once after `ClientReady`. Used for boot
   messages, startup checks.
4. `**onShutdown**` — runs in **reverse** registration order during
   graceful shutdown (`SIGINT` / `SIGTERM`). Failures are logged but
   never fatal, and disabled status does not skip it (see the Plugin
   contract above).

A plugin whose hook throws is marked disabled and the bot keeps
running. No plugin can abort startup: a feature module is optional by
construction, so a failure in one is a degraded bot, not a dead one.

A plugin that owns an HTTP listener (`earthquake`, `settings-api`)
closes it through `closeServerBounded`
([src/core/http/shutdown.ts](../src/core/http/shutdown.ts)), which
destroys live sockets first and gives up after two seconds. Plain
`server.close()` waits for every idle keep-alive connection, which would
consume the whole shutdown budget the signal handler is working within.

## 5. Built-in plugins

| Plugin                    | Path                               | Summary                                                                                                                 |
| ------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `AutoReplyPlugin`         | `src/plugins/auto-reply/`          | `messageCreate` keyword replies, operator-configured per-user lucky replies, and a dice roller                          |
| `GuildEventsPlugin`       | `src/plugins/guild-events/`        | guild / member lifecycle events, plus the pre-delete attachment cache that beats Discord's CDN purge race               |
| `GiveawayPlugin`          | `src/plugins/giveaway/`            | scheduled giveaways (modal-driven create, select-menu delete) with reaction-driven winner selection                     |
| `TempRolePlugin`          | `src/plugins/temp-role/`           | temporary, permission-less self-claim notification roles with a hard 30-day expiry (nijika, tomori)                     |
| `ActivityPlugin`          | `src/plugins/activity/`            | per-member activity tracking via message / reaction events                                                              |
| `MessageBackupPlugin`     | `src/plugins/message-backup/`      | message create / delete / update archival (used by the `msg-archive` worker)                                            |
| `LlmChatPlugin`           | `src/plugins/llm-chat/`            | multi-provider LLM chat with web-search toggle and session persistence                                                  |
| `EarthquakePlugin`        | `src/plugins/earthquake/`          | earthquake alert broadcast (nijika exposes the HTTP webhook)                                                            |
| `LlmAutoReplyPlugin`      | `src/plugins/llm-auto-reply/`      | probability-gated, context-aware `messageCreate` reply via a self-hosted LLM (gopher)                                   |
| `SocialLinkPreviewPlugin` | `src/plugins/social-link-preview/` | rewrites/embeds social-media share-link previews and suppresses the original (nijika, tomori)                           |
| `SettingsApiPlugin`       | `src/plugins/settings-api/`        | owner-only, bearer-authenticated HTTP REST API to update the LLM `endpoint` at runtime + persist it (gopher)            |
| `IdentitySyncPlugin`      | `src/plugins/identity-sync/`       | daily avatar/nickname sync with a source user, or a static fallback identity (gopher)                                   |
| `SocialFeedPlugin`        | `src/plugins/social-feed/`         | polls each guild's stored feed subscriptions and forwards the new posts each subscription's own filter accepts (nijika) |

## 6. Personalities

Each composition root under `src/bot/<name>/` is a thin `BaseBot`
subclass that opts plugins in. Personalities ship with a
`config.example.json` checked into the repo; the real `config.json`
is per deployment and `.gitignore`d.

| Personality   | Notable surface                                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `nijika`      | Web-facing; exposes an Express `/discord/earthquake` webhook, and forwards new social-media posts into the channels each guild has subscribed them to                                                                                      |
| `konata`      | Full interactive feature set                                                                                                                                                                                                               |
| `tomori`      | Public-facing; nijika's interactive plugin set minus the self-guild-only surfaces (earthquake webhook, level-role sync), with a custom ready-time presence                                                                                 |
| `msg-archive` | Worker-style; suppresses interaction / reaction / guildCreate listeners on its `BaseBot` subclass and runs only the `MessageBackupPlugin` (backup always runs; the per-run transcript log is opt-in via `backup_log_enabled`, default off) |
| `gopher`      | Database-free ("老鼠人"); self-hosted-LLM auto-reply, an owner-only settings REST API, and a daily avatar/nickname identity sync                                                                                                           |

## 7. Locales

Two locales ship out of the box: `en` and `zh-TW`. Catalog files are
split into three namespaces:

- `commands.json` — slash-command names, options, descriptions.
- `errors.json` — error strings keyed by `DomainError.messageKey`.
- `replies.json` — user-facing prose (help text, confirmations).

A CI parity check ensures the two locales stay key-aligned.

## 8. Design trade-offs

Cross-cutting pattern choices, and why each was preferred over the
obvious alternative.

- **Manual typed IoC, no `reflect-metadata` / DI framework** — a ~280-line
  `ServiceContainer` keeps the wiring explicit and the container's write face
  inside the composition root.
- **Repository pattern + in-memory fakes** over raw Mongoose — handlers and
  plugins depend on `<X>Repo` interfaces, so tests inject fakes without a
  database.
- **Provider Strategy mirrored for LLM, Link-Preview, and Social-Feed** — every
  outbound surface shares the same "interface + selection + per-provider SDK
  error translation" shape (`src/infra/llm/`, `src/infra/link-preview/`,
  `src/infra/social-feed/`), so a new one is a directory here rather than a new
  pattern. What differs is only how one is selected: LLM and Link-Preview walk
  an ordered registry because they pick among several providers per call, while
  a feed platform is looked up by the id the subscription already names.
- **One upstream read per followed account per poll pass** — the feed poller
  groups every subscription in the pass by `(platform, account)` across guilds
  and channels, then asks for posts newer than the **oldest** cursor in the
  group. A second guild following the same account therefore costs no extra
  request, and no subscriber's posts can be hidden by a neighbour's newer
  cursor. The hint is dropped entirely on a full sweep and whenever any member
  of the group has never been seeded, since neither can be served by a floor.
  Cursors still advance per subscription, and only after a post has actually
  reached Discord.
- **`PermissionRankPolicy` as a static, discord.js-free core service** built
  once in the `BaseBot` constructor, chosen over binding rank into
  `GuildRegistry` to avoid event-before-registration races.
- **Full-ancestry effective rank**, folded monotonically over channel → parent
  → category so a private category gates everything beneath it and degrades
  fail-safe when an ancestor is uncached.
- **Index-served numeric timestamps** over a computed `$toLong` predicate, after
  a one-time `db migrate-timestamp` backfill.
- **Fail-fast zod configuration** validated at startup; a malformed
  `permission_rank` block aborts the boot per-guild rather than fail-open.
