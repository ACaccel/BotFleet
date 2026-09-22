# Locale catalogs

One folder per supported locale. Each folder mirrors the same set of JSON
files (namespaces) — adding a key to one locale without the others trips
the `catalog-completeness` test in CI.

## Namespaces

| File            | Purpose                                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands.json` | Slash command `name` / `description` strings sourced for Discord `name_localizations` / `description_localizations`. Key shape: `<feature>.name`, `<feature>.description`, `<feature>.options.<opt>.name`, `<feature>.options.<opt>.description`. |
| `errors.json`   | User-facing translation of `DomainError.messageKey`. Key shape: `<error_class>.<reason>` (e.g. `llm.rate_limited`).                                                                                                                               |
| `replies.json`  | All other user-facing replies the bot issues. Key shape: `<feature>.<outcome>` (e.g. `giveaway.created`).                                                                                                                                         |

## Key naming convention

`<namespace>.<feature>.<purpose>` — lowercase, dot-separated, no spaces or
CJK in keys. Use ICU-style `{{placeholder}}` (i18next syntax, NOT
single-brace) for interpolation. Pluralisation uses i18next plural keys
(`<key>_one`, `<key>_other`).

## Enforcement

The CJK-literal scanner (`test/i18n/no-literal-cjk.test.ts`) fails the
build on any CJK string literal in `src/handlers/`, `src/plugins/`, or
`src/bot/` — every user-facing string must reach Discord through the
translator (`translator.t(key, params)`). Annotate a genuinely
unavoidable literal with `// i18n-ignore: <reason>`.

## Adding a new language

1. Create `src/i18n/locales/<locale>/{commands,errors,replies}.json`
   mirroring the existing keys.
2. Add the literal to the `Locale` union in
   `src/core/i18n/translator.ts`.
3. Register the locale in `src/core/i18n/locale-resolver.ts`
   (`SUPPORTED` set + `normalizeDiscordLocale` mapping if Discord sends a
   regional variant).
4. Run `npm run test:i18n` — the catalog-completeness test will fail until
   every key is translated.
