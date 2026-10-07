# Adding a plugin

Part of the [contributing guide](../../CONTRIBUTING.md).

Use plugins for bot-scoped jobs and listeners; interactions belong in `src/handlers/`.

1. Create `src/plugins/<name>/plugin.ts`: a private zod schema, inferred config
   type, and factory returning [`Plugin`](../../src/core/plugin/types.ts).
   Parse and capture config in the factory so invalid values fail at composition.
2. Set a unique `id` and `version`; implement the required hooks and subscriptions.
   Export the factory and config type through both plugin and
   [shared indexes](../../src/plugins/index.ts).
3. Register with `this.use(createXxxPlugin(config))` in the personality constructor.
   Add user-facing text to both locale catalogs; update config examples and docs.
4. Test pure logic, lifecycle/event wiring, failures, and cleanup under
   `test/unit/plugins/`. Run the [quality gates](../../CONTRIBUTING.md#quality-gates).

Lifecycle order is `init` → `start` → `onReady`; shutdown reverses registration
order. Startup failure disables the plugin; `onShutdown` must handle partial
initialization. Use `onGuildDatabaseReady` to rebuild jobs after database recovery.

Resolve dependencies in `init`; subscriptions attach after it succeeds.
Gate channel behavior with `PermissionRankPolicy` and add feature keys to
`RankedFeature` as needed. Do not add per-plugin `blockedChannels` lists.

## Plugin ↔ IoC contract

Use [`TOKENS`](../../src/bot/tokens.ts) with `ctx.resolve(token)` and publish
instances with `ctx.registerInstance(token, instance)` **only inside `init`**;
duplicate registrations fail. Add new tokens to that catalog.
ESLint forbids imports from `@core/ioc` and `src/bot/<name>/**`.
Do not cast the context to access the container.
