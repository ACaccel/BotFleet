# Adding a slash command

Part of the [contributing guide](../../CONTRIBUTING.md).

1. Create `src/handlers/commands/<snake_case_name>/index.ts`, extending `Command`
   from `@cmd`. The directory names the command; follow a similar existing handler.
   Use `setConfig` for metadata and a category from the
   [command contract](../../src/handlers/commands/command.ts).
2. Keep Discord input, authorization, translation, and replies in the handler;
   defer before slow work. Add matching keys and placeholders to both `zh-TW`
   and `en` catalogs: metadata in `commands.json`, replies in `replies.json`,
   failures in `errors.json`. `replyForError` fallbacks need `{{traceId}}`.
3. Run `npm run handlers:gen`, include its output, and enable the command in the
   intended bots' `config.json` commands arrays. Update examples and affected docs.
4. Test happy and failure paths with [Discord fixtures](../../test/fixtures/discord/README.md).
   For MongoDB, use [`withFreshConnection`](../../test/integration/helpers/mongo.ts).
   Port-binding tests without MongoDB belong in `integration-nodb` and
   `NO_DB_INTEGRATION` in [`vitest.workspace.ts`](../../vitest.workspace.ts).
5. [Register](local-setup.md#registering-slash-commands) in a test guild, then
   globally when ready. Run the [quality gates](../../CONTRIBUTING.md#quality-gates).

## Subcommand groups

Use `subcommands` for `/command subcommand` and `subcommandGroups` for
`/command group subcommand`; both can appear on one command, but neither can
coexist with root `options`. Localize root subcommand descriptions/options under
`commands:<command>.subcommands.<subcommand>`, group descriptions under
`commands:<command>.groups.<group>.description` and subcommand descriptions/options
under `.groups.<group>.subcommands.<subcommand>`. See the [archive handler](../../src/handlers/commands/archive/config.ts)
for root subcommands with boolean and integer options.
`guildOnly` and `defaultMemberPermissions` constrain registration; handlers must
still validate guild scope and permissions at execution time.

For durable operational actions, delegate persistence and bounded inspection to
an infra service. Confirmation buttons must recheck permissions and bind the
action to the original operator, guild, channel and reviewed state; use durable
tokens rather than in-memory collectors when restart recovery is required. See
the [archive control contract](../message-archive.md#access-and-confirmations).

## Option autocomplete

- Set `autocomplete: true` on a string option without `choices`; return
  `Promise<CommandSuggestions>`. The dispatcher calls `respond` and enforces
  25 choices and 100 characters per name/value; discard unsafe truncations.
- Read focus with `interaction.options.getFocused()` and siblings with
  [option helpers](../../src/infra/discord/options.ts). Siblings may be absent;
  entity values are raw IDs.
- Use a database or cache, never an upstream request: responses have a three-second
  deadline. Return `[]` for unusable states and log actionable failures at info level.
- Apply visibility checks, translate fixed labels, and test shape, refusals, limits,
  and catalog constants with `buildAutocompleteInteraction`. Follow
  [`/feed unsubscribe`](../../src/handlers/commands/feed_unsubscribe/action.ts).

## Handler 150-line cap

ESLint limits `src/handlers/<type>/<name>/index.ts` to **150 lines**, including
blank lines. Extract pure logic into sibling kebab-case files with named exports
and explicit return types; use `unknown` and narrowing instead of `any`.
Keep Discord I/O, permissions, repository checks, translation, and reply assembly
in the root handler or its internal `action.ts`. Test helpers under `test/unit/handlers/<name>/` for happy, boundary,
and error paths; promote them to a lower layer only when another handler needs them.

## Shared handler utilities

Use [typed options](../../src/infra/discord/options.ts) matching each declared
`required` flag, [bounded HTTP](../../src/infra/http/index.ts) with zod validation,
[paged replies](../../src/infra/discord/send-paged-reply.ts), and
[`requireCapture`](../../src/core/regex-capture.ts) for regex captures.
Validate per-bot configuration with `Command.validateBotConfig`; see
[`weather_forecast/config.ts`](../../src/handlers/commands/weather_forecast/config.ts).
Code a command shares with plugins lives in `src/application/`; see
[layers and boundaries](../architecture.md#layers-and-boundaries).
A `channel` option accepts the text-capable channels and threads by default; set
`channelTypes` on the option to narrow or widen that list (for example to add forum
and media channels).
Renderers and view helpers shared by one command group live in its `<group>-shared/`
folder (for example the `/traffic` dashboards in `traffic-shared/dashboard/`), while
SDK adapters they draw on, such as fonts, colour emoji and the bounded CDN
[image loader](../../src/infra/graphics/image-loader.ts), live in `src/infra/graphics/`.

## Privacy-aware data commands

Activity, ranking, and message-count commands must follow the
[privacy rules](../architecture.md#privacy-aware-data-commands): filter queries
and results by channel visibility and respect the reply audience.

## Grouping related actions

Use `GroupedCommand` for related slash actions. Its root declares a category and
routes shaped as `{ name, command }` or `{ group, name, command }`; it derives
subcommand options from the action metadata and delegates both execution and
autocomplete. An action that already declares subcommands supplies the matching
child options, as in `thread manager`. Preserve authorization inside each action;
never apply an administrator-only root gate to a mixed-access family.

Only root handlers have an `index.ts` entry in their immediate command directory.
Internal action implementations use `action.ts` and are not registered directly.
Descriptions/options live under `commands:<root>.subcommands.<action>` or
`commands:<root>.groups.<group>.subcommands.<action>`. Keep button and modal IDs
independent of slash command names. Test grouped dispatch, unknown routes,
autocomplete routing, localized registration, and the existing action behavior.
Regenerate handlers and update configuration and the
[migration guide](../upgrading.md#grouped-slash-commands) when replacing public entries.
