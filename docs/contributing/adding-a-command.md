# Adding a slash command

Part of the [contributing guide](../../CONTRIBUTING.md).

Pick a snake_case name that matches the Discord command name
convention (e.g. `add_reply`). The directory name **becomes** the
command name; do not rename it after handlers are registered with
Discord.

1. **Create the handler.**

   ```ts
   // src/handlers/commands/my_command/index.ts
   import { ChatInputCommandInteraction } from 'discord.js';
   import { BaseBot } from '@bot';
   import { Command } from '@cmd';
   import { logger } from '@utils';

   export default class MyCommand extends Command {
     constructor() {
       super();
       this.setConfig({
         name: 'my_command',
         // Groups the command under a `/help` section. Pick the closest
         // CommandCategory: auto_reply | fun | server_activity | utility |
         // admin | ai | other. Omitting it defaults to `other`.
         category: 'utility',
         // i18n-ignore: command-builder metadata; localised via name_localizations.
         description: '<short description>',
         options: {
           /* … */
         },
       });
     }

     public override async execute(
       interaction: ChatInputCommandInteraction,
       bot: BaseBot,
     ): Promise<void> {
       await interaction.deferReply();
       try {
         // do work, then:
         await interaction.editReply({
           content:
             bot.translator?.t('replies:my_command.success', {
               /* params */
             }) ?? '',
         });
       } catch (err) {
         logger.errorLogger(bot.clientId, interaction.guild?.id, err);
         await interaction.editReply({
           content: bot.translator?.t('replies:my_command.failed') ?? '',
         });
       }
     }
   }
   ```

2. **Add the i18n keys — in every locale.** The catalog is bilingual
   (`zh-TW` and `en`). Open **both**
   `src/i18n/locales/zh-TW/replies.json` and
   `src/i18n/locales/en/replies.json` and add the same namespace
   to each:

   ```json
   // zh-TW/replies.json
   "my_command": {
     "success": "✅ {{thing}} 已建立",
     "failed": "唔...執行失敗了,稍後再試一次看看吧!(錯誤代碼:{{traceId}})"
   }
   ```

   ```json
   // en/replies.json
   "my_command": {
     "success": "✅ {{thing}} created",
     "failed": "Hmm... it failed. Give it another try later! (error code: {{traceId}})"
   }
   ```

   Rules the `yarn test:i18n` catalog-completeness gate enforces:
   - **Every key must exist in both locales.** A key added to one
     locale only fails the cross-locale parity check.
   - **`{{placeholder}}` sets must match across locales** for the same key.
   - The per-command `replies:<feature>.failed` fallback string must
     carry a `{{traceId}}` interpolation slot — `replyForError` uses it
     to surface a trace code for non-`DomainError` failures.
   - Command metadata (description / option descriptions / choices)
     lives under `commands.json`, again in both locales.

   Reuse `errors.json` keys for cross-cutting failures
   (`errors:db.not_found`, `errors:permission.denied`, etc.); those
   strings carry the bot-facing tone for `DomainError.messageKey`.

3. **Regenerate the codegen registry.**

   ```bash
   yarn handlers:gen
   ```

   This rewrites `src/handlers/commands/registry.generated.ts`. Commit
   the regenerated file.

4. **List the command in the bots that should expose it.** Edit each
   `src/bot/<name>/config.json` `commands` array.

5. **Add a test.** The minimum is a unit test asserting one happy and
   one failure path. Build the Discord objects with the shared builders
   in [`test/fixtures/discord/`](../../test/fixtures/discord/README.md) —
   `buildFakeBot`, `buildGuild`, `buildSendableChannel` and friends —
   rather than hand-rolling another `as unknown as BaseBot` literal.

   If the command touches MongoDB, add an integration test under
   `test/integration/` that uses the `withFreshConnection` helper from
   `test/integration/helpers/mongo.ts` (it reuses the shared
   `mongodb-memory-server` started in `test/integration/setup.ts`).
   A suite that binds a real port but needs no database belongs in the
   `integration-nodb` project instead — add its path to
   `NO_DB_INTEGRATION` in `vitest.workspace.ts` so a memory-server
   failure cannot take it down.

6. **Register with Discord.** `yarn register -t <bot-name>` after the bot
   has been started at least once. Default is global; `--dev-guild <id>`
   is for fast iteration on a single test guild.

## Option autocomplete

A string option can ask Discord to query the handler as the member
types, instead of offering a fixed list.

1. **Flag the option.** Set `autocomplete: true` on it in `setConfig`.
   The flag applies to **string options only** and is **mutually
   exclusive with `choices`** — Discord rejects an option carrying both.
   `buildCommandJsonBody` fails with a `TypeError` naming the command
   and the option on either misuse, so the mistake surfaces in the unit
   suite rather than as an opaque REST 400 at `yarn register` time.

2. **Implement the hook.**

   ```ts
   public override autocomplete(
     interaction: AutocompleteInteraction,
     bot: BaseBot,
   ): Promise<CommandSuggestions> {
     return suggestSomething(interaction, bot);
   }
   ```

   Read the option being typed into with
   `interaction.options.getFocused()` and its siblings with the
   accessors in `src/infra/discord/options.ts` — on an autocomplete
   interaction `options.getChannel` and the other entity resolvers do
   not exist, because Discord resolves entities only once the command is
   submitted, so a channel option is read as its raw id string. Every
   sibling option may still be absent.

3. **Return suggestions; never send them.** The hook hands back a list
   and `executeAutocomplete` answers with it. Discord's limits are
   applied there — at most 25 choices, 100 characters per name and per
   value — so no handler can produce a payload the API rejects. A hook
   that could produce an over-long value should still drop that
   candidate itself: truncation is a backstop, and half a value is
   usually worse than no suggestion.

4. **Never reply, never throw.** An autocomplete interaction cannot be
   replied to and has no way to report a failure to the member. A
   command with no hook, an unknown command name, a hook that throws,
   and a `respond` Discord refused all end in an empty list. Return
   `[]` for every unusable state rather than throwing — the dispatcher
   would swallow the throw anyway, at the cost of an error-level line
   per keystroke for something the member cannot act on.

   Log the states an operator could act on yourself, at info level, and
   include the reason. The dispatcher only logs a hook that threw and a
   `respond` Discord refused; a hook that quietly returns `[]` after a
   failed read would otherwise leave a degraded dependency with no
   trace anywhere, because the member sees the same empty dropdown
   either way.

5. **Route any fixed wording through the translator.** A suggestion's
   `name` is user-facing text in Discord's own dropdown, and it is the
   one handler surface that renders copy with no `t` call in sight — the
   CJK-literal scanner cannot see an English literal, so nothing else
   will catch it. Interpolate data freely; take every fixed word from a
   catalog key. A label assembled purely from stored values and a
   locale-independent constant needs no key, but if that constant is
   also spelled in the catalog somewhere (a platform name in an option's
   `choices`, say), pin the two together with a test — a member reads
   both lists side by side, and nothing else notices when they drift.

6. **Answer within three seconds.** Discord discards a later response.
   A hook belongs on a database read or a cache, never on an upstream
   call. `/feed_unsubscribe` is the worked example: it suggests the
   accounts the target channel has already subscribed, read from the
   repository, and applies the same visibility gate the command does so
   a channel the invoker cannot see yields nothing.

7. **Test it.** Cover the suggestion shape, the refusal paths, and the
   limits. Build the interaction with `buildAutocompleteInteraction`
   from [`test/fixtures/discord/`](../../test/fixtures/discord/README.md),
   whose sink records `respond` calls.

## Handler 150-line cap

Every `src/handlers/<type>/<name>/index.ts` must follow these five
rules. New handlers apply them from line one — no "future cleanup"
deferrals.

1. **`index.ts` is capped at 150 lines** (imports, JSDoc, and blank
   lines all count). Enforced by the `max-lines` rule in
   [`eslint.config.mjs`](../../eslint.config.mjs); a violation is an ESLint
   error, not a warning.
2. **Overflow goes to sibling files in the same directory.** Pure
   helpers (anything that does not touch Discord objects) move to
   kebab-cased files (e.g. `parse-range.ts`, `render-reactions.ts`)
   with **named** exports. Do not use `export default`. Every export
   from `src/` names its return type — `explicit-module-boundary-types`
   is an error, so an omitted annotation fails `yarn lint`. `any` is an
   error everywhere in `src/`; reach for `unknown` and narrow.
3. **Do NOT extract Discord I/O, permission checks, or `Translator`
   calls to compress the line count.** Those four belong in
   `index.ts`: interaction input extraction; guild / repos / permission
   checks; `bot.translator.t(...)` calls; assembling the domain result
   into a Discord reply. They are the handler's job.
4. **Extracted helpers must have unit tests** under
   `test/unit/handlers/<name>/<helper>.test.ts`. Test happy path,
   boundary, and error path for pure functions; inject in-memory fakes
   for `Translator` / `Repos` consumers.
5. **Helpers stay in the handler's own directory.** Do not put them in
   `src/handlers/shared/` or a new common folder; they are
   implementation details of this handler. Promote only when a second
   handler legitimately needs the same logic.

## Shared handler utilities

These cross-handler modules already exist. Use them rather than
re-deriving the behaviour:

- **`src/infra/discord/options.ts`** — `getRequiredString` /
  `getRequiredNumber` / `getOptionalString` / `getOptionalNumber` /
  `getOptionalChoice`. Never write
  `interaction.options.get('x')?.value as string`: that cast types a
  missing option as a present `string`, so the failure surfaces far
  from the read. Mirror the option's declared `required` flag — a
  `getRequired*` on an absent option throws a `TypeError`, which the
  handler's `replyForError` boundary turns into a trace-id-stamped
  reply and an operator log line.
- **`src/infra/http/`** — `boundedHttp` (an axios instance carrying a
  request timeout, a response-size ceiling and a redirect cap) plus
  `getJson` / `postJson`, which validate the body against a zod schema.
  Bare `axios` has no default timeout, so an upstream that accepts the
  connection and stalls leaves the deferred reply hanging for the life
  of the process — and its `response.data` is `any`, so a changed
  upstream shape surfaces as a `TypeError` somewhere far from the read.
  Prefer the JSON helpers; keep the raw instance for non-JSON bodies.

  Both of these live in `infra/`, not `handlers/`, because `handlers`
  and `plugins` are **sibling** layers: neither may import the other,
  and both may import `infra`. An ESLint rule enforces the
  `plugins -> handlers` half.

- **`src/infra/discord/send-paged-reply.ts`** —
  `sendPagedEphemeralReply(interaction, pages, { logger, partialNotice })`
  for a listing too long for Discord's 2000-character message limit. It
  sends page 1 as the `editReply` and the rest as follow-ups, isolating
  each one: a rejected page is logged and skipped, the remaining pages
  still go out, and the gap is reported with one extra follow-up. Do not
  hand-roll the loop — an unguarded `followUp` rejection escapes to the
  handler's `catch`, where `replyForError` overwrites page 1 with the
  error line and the user is left with no listing at all.

- **`src/core/regex-capture.ts`** — `requireCapture(match, group)`.
  Never write `match[1] as string`: under `noUncheckedIndexedAccess` a
  capture group is `string | undefined`, and the cast turns a pattern
  that later gains a `?` into an `undefined` flowing silently
  downstream. It lives in `core/` rather than `infra/` because it
  touches nothing but the standard library.

- **`Command.validateBotConfig(botConfig)`** — implement it when the
  handler needs a per-bot `config.json` block, and throw when the block
  is missing or malformed. `registerCommands` calls it once per enabled
  command, logs the failure with its cause, and skips just that
  command, so a misconfiguration shows up in the boot log instead of a
  puzzling reply. `weather_forecast` and `random_restaurant` are the
  worked examples; each keeps its zod schema in a sibling `config.ts`.

## Privacy-aware data commands

A command that surfaces aggregated guild data (message counts,
rankings, traffic) must not reveal activity from channels the invoker
cannot see. The full pattern — dual filtering, audience-driven
ceilings, fail-safe channel sets, neutral copy — is documented in
[`docs/architecture.md` §Privacy-aware data commands](../architecture.md#privacy-aware-data-commands);
follow it for any new command of this kind.
