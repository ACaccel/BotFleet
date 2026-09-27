# Adding a plugin

Part of the [contributing guide](../../CONTRIBUTING.md).

Use plugins for bot-scoped behavior such as scheduled jobs, event subscriptions,
and message listeners. Interaction handlers remain under `src/handlers/` and
use the generated registries.

1. Create `src/plugins/<name>/plugin.ts` with a private zod config schema,
   its inferred config type, and a factory returning `Plugin`. Parse the raw
   config in the factory and capture the result; malformed config must fail
   at composition time.
2. Give the plugin a unique `id` and a `version`. Implement only the lifecycle
   hooks and Discord event subscriptions it needs. The authoritative contract
   is [`src/core/plugin/types.ts`](../../src/core/plugin/types.ts).
3. Export the factory and config type through the plugin's `index.ts` and
   [`src/plugins/index.ts`](../../src/plugins/index.ts).
4. Register it in the personality constructor with `this.use(createXxxPlugin(config))`.
   Keep user-facing text in both locale catalogs, and update configuration
   examples and affected documentation.
5. Test pure logic and lifecycle/event wiring under `test/unit/plugins/`,
   including error paths and cleanup.

Lifecycle order is `init` → `start` → `onReady`; shutdown runs in reverse
registration order. A failed startup hook disables that plugin while the bot
continues. `onShutdown` must tolerate partially initialized state because it
also runs for disabled plugins. Use `onGuildDatabaseReady` when guild-scoped
jobs need rebuilding after database recovery.

Resolve dependencies in `init` and let event closures reuse them. The host
attaches subscriptions only after successful initialization. Gate applicable
channel behavior through `PermissionRankPolicy`; do not add per-plugin
`blockedChannels` lists. Add new feature keys to `RankedFeature` as needed.

## Plugin ↔ IoC contract

Import `TOKENS` from `src/bot/tokens.ts`, the shared token catalog:

- Read dependencies with `ctx.resolve(token)`.
- Publish built instances with `ctx.registerInstance(token, instance)` **only
  inside `init`**. Later calls and duplicate registrations fail.

Plugins cannot import `@core/ioc` or personality composition roots
(`src/bot/<name>/**`); ESLint enforces these boundaries. Do not cast a context
to access the container. New tokens belong in the existing catalog, outside
`core`, because their types may reference outer layers.
