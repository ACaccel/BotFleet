# Adding a slash command

Part of the [contributing guide](../../CONTRIBUTING.md).

1. Create `src/handlers/commands/<snake_case_name>/index.ts`, extending
   `Command` from `@cmd`. The directory becomes the Discord command name.
   Follow an existing command with similar inputs and reply behavior.
2. Set command metadata with `setConfig`: name, description, options, and
   category (`auto_reply`, `fun`, `server_activity`, `utility`, `admin`, `ai`,
   or the default `other`). Keep Discord input, authorization, translation,
   and replies in the handler; defer replies before slow work.
3. Add text to **both** `zh-TW` and `en` catalogs. Metadata belongs in
   `commands.json`, replies in `replies.json`, and shared failures in
   `errors.json`. Keys and interpolation placeholders must match across
   locales. Failure fallbacks used by `replyForError` need `{{traceId}}`.
4. Run `npm run handlers:gen` and include the generated registry in the
   change. Enable the command in the intended bots' `config.json` commands
   arrays and update their examples and affected documentation.
5. Test a happy path and a failure path using the shared
   [Discord fixtures](../../test/fixtures/discord/README.md). MongoDB behavior
   needs an integration test with `withFreshConnection` from
   `test/integration/helpers/mongo.ts`. Tests that bind ports but need no
   database belong in `integration-nodb`; list them in `NO_DB_INTEGRATION`
   in `vitest.workspace.ts`.
6. Follow the [registration procedure](local-setup.md#registering-slash-commands)
   to publish the command to a test guild, then globally when ready.

## Option autocomplete

- Set `autocomplete: true` on a **string** option; it cannot also have
  `choices`. Override `autocomplete` and return `Promise<CommandSuggestions>`.
- Read the focused value with `interaction.options.getFocused()` and sibling
  values with `src/infra/discord/options.ts`. Siblings may be absent; entity
  values are raw IDs because autocomplete does not resolve Discord objects.
- Return suggestions; the dispatcher calls `respond`. It enforces 25 choices
  and 100 characters per name/value. Drop candidates whose values cannot be
  safely shortened.
- Return `[]` for unusable states. Autocomplete cannot send an error reply;
  log actionable dependency failures at info level. Use a database or cache,
  never an upstream request: Discord requires a response within three seconds.
- Apply the command's visibility checks and translate fixed wording in labels.
  Stored values need no translation; test any constants shared with catalogs.
- Test suggestion shape, refusal paths, and limits with
  `buildAutocompleteInteraction`. See `feed_unsubscribe` for an example.

## Handler 150-line cap

Each `src/handlers/<type>/<name>/index.ts` is limited to **150 lines**, including
imports, comments, and blank lines. ESLint enforces this cap.

Extract pure logic to sibling kebab-case files with named exports and explicit
return types. Keep input extraction, Discord I/O, permissions, repository
availability checks, translator calls, and reply assembly in `index.ts`.
Use `unknown` and narrowing instead of `any`.

Test extracted helpers under `test/unit/handlers/<name>/`, covering happy,
boundary, and error paths. Keep helpers local until a second handler needs
them; then promote shared logic to the appropriate lower layer.

## Shared handler utilities

| Utility                                 | Use                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/infra/discord/options.ts`          | Typed required/optional option access; match the declared `required` flag instead of casting values       |
| `src/infra/http/`                       | Bounded HTTP requests; `getJson` / `postJson` validate responses with zod                                 |
| `src/infra/discord/send-paged-reply.ts` | `sendPagedEphemeralReply` for long listings, with isolated follow-up failures and a partial-result notice |
| `src/core/regex-capture.ts`             | `requireCapture` to validate capture groups instead of casting potentially missing values                 |
| `Command.validateBotConfig`             | Validate required per-bot configuration at registration; invalid commands are logged and skipped          |

Handlers and plugins are sibling layers and must not import each other.
Shared adapters belong in `infra/`. For command-specific config schemas, see
`weather_forecast/config.ts` or `random_restaurant/config.ts`.

## Privacy-aware data commands

Commands showing guild activity, rankings, or message counts must not reveal
channels the invoker cannot see. Follow the
[privacy rules](../architecture.md#privacy-aware-data-commands), including
filtering both queries and results and respecting the reply audience.
