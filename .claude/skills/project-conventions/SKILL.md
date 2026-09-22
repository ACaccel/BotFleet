---
name: project-conventions
description: Architectural framework rules for the BotFleet project. Apply before adding, deleting, or modifying any code under src/.
---

# Project Framework and Rules (project-conventions)

This skill is the framework contract for the BotFleet codebase.
Every piece of code produced under `src/` must comply. Read this file
before writing; after writing, verify each item in the section 10
self-check list.

Authoritative public sources:
[`docs/architecture.md`](../../../docs/architecture.md),
[`AGENTS.md`](../../../AGENTS.md),
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md). When this file conflicts
with the public design documents, the design documents win.

## 1. Layering and dependency direction (hard rule)

Dependencies flow one way, downward. No reverse edges, no
layer-skipping:

```
bot -> plugins -> handlers -> infra -> persistence -> core
```

| Layer          | Path                           | May import                                                              | Must NOT import                                                              |
| -------------- | ------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| core           | `src/core/` (excl. ioc/plugin) | stdlib, zod, i18next, pino, dotenv                                      | any other `src/` module, discord.js (type-only excepted), mongoose, LLM SDKs |
| ioc            | `src/core/ioc/`                | core types, infra / persistence types (type-only)                       | concrete implementations                                                     |
| plugin runtime | `src/core/plugin/`             | core siblings, ioc                                                      | persistence, infra                                                           |
| persistence    | `src/persistence/`             | core, mongoose, `GuildConnection` / error-translator from `infra/mongo` | discord.js, LLM SDKs                                                         |
| infra          | `src/infra/`                   | core, `persistence/schemas`, the SDKs                                   | handlers, plugins, bot                                                       |
| handlers       | `src/handlers/`                | core, persistence (types), infra, `@core/*`, `@bot` (type-only)         | concrete bot implementations                                                 |
| interface      | `src/i18n/`                    | nothing (pure JSON catalog)                                             | —                                                                            |
| plugins        | `src/plugins/`                 | core, persistence, infra, handlers, `@bot`                              | another plugin's internals                                                   |
| bot            | `src/bot/`                     | all of the above (the only layer that may import `core/ioc`)            | —                                                                            |

- `core/` is a leaf: zero in-`src/` dependencies.
- Only `src/bot/**` (composition roots) and `test/**` may import
  `src/core/ioc`; all other layers are blocked by the ESLint
  `no-restricted-imports` rule. Layered code receives dependencies via
  constructor injection.
- Known real edges: `infra/mongo` -> `persistence/schemas` (builds the
  model registry); `persistence` -> `GuildConnection` from
  `infra/mongo`.

## 2. Plugin contract

Business features are always a `Plugin` (`src/core/plugin/types.ts`).
There is no business-behavior carrier outside the plugin layer;
`BaseBot` is not subclassed to carry behavior.

- Required: `id`, SemVer `version`.
- Optional: lifecycle hooks (`init` / `start` / `onReady` /
  `onShutdown`) and `events`.
- Config is not part of the contract. The factory
  `create<X>Plugin(rawConfig)` parses it with `parse<X>Config` at
  composition time and closes over the result, so a malformed block
  fails the boot rather than the first event.
- Handlers are not declared on the plugin. The codegen registries under
  `src/handlers/<type>/registry.generated.ts` are the single
  registration mechanism.
- Phases run in registration order; `onShutdown` runs in reverse. A
  hook that throws disables that plugin and the phase continues — no
  plugin can abort startup.
- Dependencies are obtained via `ctx.resolve(TOKENS.X)`. Service
  Locator is forbidden inside runtime hooks — a plugin never holds the
  raw container.

## 3. IoC container

- `ServiceToken<T>` is typed; tokens are centralised in `TOKENS` at
  `src/bot/tokens.ts` — register new dependencies there. The catalog
  lives with the composition root, not in `core`, because it names
  concrete `infra` / `persistence` / `plugins` types.
- `core/ioc` owns the mechanism only, and its surface is
  `registerSingleton` / `resolve` / `tryResolve`. Singleton is the only
  lifetime; per-guild state is reached through a factory token
  (`ReposFactory`).
- Do not introduce `reflect-metadata` or any third-party DI framework.
- A factory receives only `Resolver` (no register); the composition
  root receives `ServiceContainer`.
- Plugins import `TOKENS` from `src/bot/tokens` and nothing else from
  the composition root except `src/bot/guild-registry`. Any direct
  import from `core/ioc`, or from a personality root
  (`src/bot/<name>/**`), inside `src/plugins/**` is blocked by ESLint.
  A plugin may call `ctx.resolve(token)` to read a dependency and may
  call `ctx.registerInstance(token, instance)` in the `init` hook to
  publish a constructed object. It must not obtain the container's
  write-side API by any means, including casting `ctx`.

## 4. Repository pattern

- Data access goes through `persistence/repositories/<x>.repo.ts`:
  `interface XRepo` + `class MongoXRepo implements XRepo`.
- Consumers depend on the interface; tests inject in-memory fakes.
- Stringly-typed lookups such as `db.models["X"]` are forbidden.
- `buildRepos(connection)` returns the `Repos` bundle bound to a guild
  connection.

## 5. Error tree and Result

- infra / persistence failures throw `DomainError` subclasses
  (`ConfigurationError`, `ExternalServiceError` -> `DatabaseError` /
  `LlmProviderError` / `LinkPreviewError` / `FeedError`). Never
  `throw new Error()` / `throw new TypeError()` to express a domain
  failure. Add a subclass only when a real boundary needs one.
- Dispatch on a `DomainError` with `instanceof`. There is no
  discriminant string field, and none is to be added.
- Every `DomainError` carries `code`, `messageKey`, `messageParams`,
  `context`, `cause`.
- Programmer errors (contract violations, invariant breaches) use
  native `TypeError` / `RangeError` — they do not enter `Result` and
  do not route through i18n.
- Use-case boundaries pass `Result<T, DomainError>`; a function
  returning `Result` must not throw `DomainError`.

## 6. i18n routing

- User-facing text always goes through `Translator` + catalog;
  `src/handlers`, `src/plugins`, `src/bot` contain zero CJK literals.
- Catalogs live at
  `src/i18n/locales/<lang>/{commands,errors,replies}.json` with key
  format `<namespace>:<feature>.<purpose>`.
- A new catalog key must be added to every locale (`zh-TW` and `en`),
  otherwise the catalog-completeness test fails.
- Operator-facing log / thrown messages are centralised as constants,
  not scattered English literals.

## 7. Handler codegen and the 150-line rule

- `src/handlers/<type>/<name>/index.ts` contains `export default class`.
- `registry.generated.ts` is a pure generated artifact — never
  hand-edit; run `yarn handlers:gen` after adding a handler. CI
  `handlers:gen:check` detects drift.
- `src/handlers/<type>/<name>/index.ts` is capped at 150 lines (ESLint
  `max-lines`, hard error). Pure helpers above the cap move into a
  sibling kebab-case file (`parse-range.ts`,
  `render-reactions.ts`, ...) with named exports.
- Discord I/O, permission checks, Translator calls, and the assembly of
  the reply object stay inside `index.ts` — they are the handler's
  core responsibilities and must not be extracted to shrink the line
  count.
- Every extracted helper has a unit test at
  `test/unit/handlers/<name>/<helper>.test.ts` covering happy path,
  boundary, and error path.
- Extracted helpers stay inside the handler directory; do not put them
  in a shared folder until a second handler genuinely needs them.

## 8. Directory and naming

- Bot and handler-type directories are kebab-case; handler
  subdirectories are snake_case and equal the Discord command name.
- Where a design pattern is applied, add a short comment stating which
  pattern and why.

## 9. Three load-bearing rules from CONTRIBUTING.md

These three rules are absolute and ride on top of everything above:

1. **No CJK literals in user-facing layers.** Every user-visible
   string in `src/handlers`, `src/plugins`, `src/bot` routes through
   the catalog. Enforced by `test:i18n`.
2. **No `process.env.X` outside `src/core/config/env.ts`.** Env access
   is centralised. Enforced by ESLint.
3. **No new handler / plugin without a test.** New public functions in
   handlers / plugins / use cases need at least one happy-path and one
   error-path test; new repository methods need an integration test.

## 10. Post-writing self-check list

After producing any `src/` code, verify each item:

- [ ] All imports obey the section 1 direction — no reverse edge, no
      layer-skipping
- [ ] No raw container access inside a plugin runtime hook (section 2)
- [ ] New dependencies registered in the `TOKENS` table, injected via
      constructor / `ctx.resolve` (section 3)
- [ ] Data access goes through a repository interface, no
      stringly-typed lookup (section 4)
- [ ] Domain failures throw `DomainError` subclasses, not raw `Error`;
      programmer errors use `TypeError` (section 5)
- [ ] User-facing text uses i18n keys, no CJK literal; new keys exist
      in both locales (section 6, 9.1)
- [ ] Codegen re-run after adding a handler; no hand-edit of
      `*.generated.ts`; `index.ts` within 150 lines; extracted helpers
      tested (section 7)
- [ ] Directory / naming follows section 8; pattern usages are
      commented
- [ ] No direct `process.env` outside `src/core/config/` (section 9.2)
- [ ] This change ships with a test (section 9.3)

Fix any failing item before delivering.
