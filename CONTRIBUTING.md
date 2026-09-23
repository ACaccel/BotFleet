# Contributing

Thanks for working on this codebase. This file is the index of the
contribution docs: it keeps the quality gates every change must pass,
the load-bearing architectural rules, and how to report a security
vulnerability. The step-by-step guides live under
[`docs/contributing/`](docs/contributing/):

- [Local setup and development loop](docs/contributing/local-setup.md) —
  prerequisites, `config.json` / `.env`, running a personality,
  registering slash commands (`npm run register`)
- [Adding a slash command](docs/contributing/adding-a-command.md) —
  the recipe, the handler 150-line cap, shared handler utilities
- [Adding a plugin](docs/contributing/adding-a-plugin.md) — the plugin
  recipe and the plugin ↔ IoC contract
- [Adding or removing a persisted model](docs/contributing/persisted-models.md)
- [Operations](docs/contributing/operations.md) — the pre-deploy
  `npm run smoke` check and the dependency-override policy
- [Commits, branching, and releases](docs/contributing/branching-and-releases.md)
  — commit conventions, the Git Flow variant, when a PR is needed

See [`docs/architecture.md`](docs/architecture.md) for the layered
architecture overview and why things are arranged the way they are.

- [Service deployment](docs/contributing/deployment.md) — project runtime, systemd, MongoDB cutover, and recovery

## Quality gates

Run the mandatory checks locally before committing. CI runs the same checks,
while the focused test commands below support development. The project hooks
described in [local setup](docs/contributing/local-setup.md) run the full set
before a push to `dev`.

| Command                      | What it checks                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`          | Strict TypeScript (`tsconfig.strict.json`) over the whole `src/`                                                                 |
| `npm run typecheck:emit`     | Emit-mode compile (`tsconfig.build.json`); checks declaration/output-specific errors. Not a deploy build (runtime is `ts-node`). |
| `npm run lint`               | ESLint                                                                                                                           |
| `npm run format:check`       | Prettier (use `npm run format` to fix)                                                                                           |
| `npm run handlers:gen:check` | Codegen registries match the on-disk handler layout                                                                              |
| `npm run test:unit`          | Unit tests (Vitest project `unit`)                                                                                               |
| `npm run test:int`           | Integration tests: the `integration` project (`mongodb-memory-server`) plus `integration-nodb` (real TCP ports, no database)     |
| `npm run test:contract`      | LLM provider contract tests via `nock`                                                                                           |
| `npm run test:i18n`          | Catalog parity + CJK-literal scanner                                                                                             |
| `npm run test`               | All six Vitest projects without coverage; useful during development                                                              |
| `npm run test:coverage`      | All six Vitest projects with coverage thresholds; the CI and pre-push test gate                                                  |
| `npm run security`           | `audit-ci` against the documented allowlist (HIGH+). The `gitleaks` secret scan and CodeQL run on GitHub only                    |
| `npm run knip`               | Unused files, dependencies, unlisted imports, exports and types — all errors                                                     |
| `npm run smoke`              | Pre-deploy boundary probe: `.env` load + Mongo `admin.ping` + Discord login until `ready`. Manual; not in the CI matrix.         |

## Architectural rules

The full picture is in [`docs/architecture.md`](docs/architecture.md).
Four rules are load-bearing — a CI gate or a reviewer will catch
violations:

1. **No CJK literals in user-facing layers.** Every user-visible
   string must come from a translator key in
   `src/i18n/locales/<lang>/{commands,errors,replies}.json`. Add
   `// i18n-ignore: <non-empty reason>` only when the literal is
   genuinely not user-facing (e.g. a trigger-match regex).
2. **No `process.env.X` outside `src/core/config/env.ts`.** Env
   access goes through the zod-parsed `Env` object so missing
   variables fail at boot, not at the first request. The rule covers
   `tools/` too; the two writes that switch the file-log sink off carry
   an explanatory inline disable.
3. **No new handler/plugin without a test.** New public functions in
   `core/` and `plugins/` need at least one happy-path and one
   error-path test; new repository methods need an integration test
   against `mongodb-memory-server`.
4. **No code change without its documentation.** A change to
   user-visible behaviour, a config field, a public contract, or a
   command updates every documentation surface it touches — in the same
   commit as the code. The surfaces are
   [`docs/architecture.md`](docs/architecture.md),
   [`README.md`](README.md), this file and the guides under
   [`docs/contributing/`](docs/contributing/), and the matching
   `src/bot/<name>/config.example.json`. A missing doc update is a
   defect, like a missing test.

   [`CHANGELOG.md`](CHANGELOG.md) is the one surface routine commits do
   not touch. It is written in a single pass when a release is cut (see
   [Releasing](docs/contributing/branching-and-releases.md)): walk every
   commit since the last tag and file one entry per notable change under
   the new version — an imperative sentence closing with a link to the
   commit that made it:
   `- <Description> ([<7-char hash>](<commit URL>)).` Deferring the
   entry to release time keeps the hash available and spares each push a
   trailing changelog commit; the price is that the release author must
   read the log rather than rely on memory.

   A changelog entry is public, permanent, and written for a general
   audience. Four content rules:
   - **High-level.** One sentence, at most two rendered lines. Say what
     changed for a user or an operator, not how it was built — no class
     names, file paths, catalog keys, mechanism narration, or rationale
     clauses.
   - **No personal or guild-specific references.** No individuals,
     nicknames, private joke features, personal third-party services, or
     one-guild content.
   - **Operator detail belongs in [`README.md`](README.md).** Keep the
     `**breaking**` marker, but make its explanation a pointer:
     `(**breaking** — see [`README.md`](README.md))`.
   - **Never drop a change from the record.** Shorten and scrub instead.
     Two entries may be merged only if they share a commit link.

## Reporting a security vulnerability

Do not open a public issue for a suspected vulnerability. Report it
privately through the repository's GitHub Security Advisory workflow
(<https://github.com/ACaccel/BotFleet/security/advisories/new>),
describing the affected code paths, the conditions needed to reproduce
it, and the impact.
