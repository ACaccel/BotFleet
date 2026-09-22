# Project: BotFleet (TypeScript, discord.js, MongoDB)

Multi-personality Discord bot framework with a layered plugin
architecture, a typed manual IoC container, Repository-pattern
persistence, an LLM-provider Strategy layer, structured errors plus
`Result` types, full i18n routing, and a CJK-literal scanner enforced
in strict mode.

## Key documents

- [`docs/architecture.md`](docs/architecture.md) — layers, key abstractions,
  request flow, plugin lifecycle, design trade-offs
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contribution index: quality-gate
  reference, architectural rules, security reporting; links the
  step-by-step guides under [`docs/contributing/`](docs/contributing/)
  (local setup, command / plugin / model recipes, operations, branching)
- [`README.md`](README.md) — feature tour and the `.env` / `config.json`
  field reference
- [`CHANGELOG.md`](CHANGELOG.md) — Keep a Changelog; one entry per notable
  change, each linking its commit, written when a release is cut

## Tech stack and versions

- Runtime: Node.js `>=22.13.0` (`.nvmrc`: `22.13.0`) · npm `10.9.2`
- Language: TypeScript `^5.6` (strict; `tsconfig.strict.json`)
- Discord: discord.js `^14.21`
- Persistence: Mongoose `^8.22` / MongoDB
- Validation: zod `^3.23` · i18n: i18next `^23.15` · Logging: pino `^10` ·
  HTTP: express `^4.21` · Charts: `canvas` `^3`
- LLM SDKs: `@anthropic-ai/sdk` `^0.94`, `openai` `^6`,
  `@google/generative-ai` `^0.24` (xAI via the OpenAI-compatible client)
- Test: vitest `^3.2` · Lint: eslint `^9` + typescript-eslint `^8` ·
  Format: prettier `^3`

## Command cheat sheet

```
Setup:      bash scripts/setup-env.sh (requires CONDA_EXE or conda on PATH)
Install:    npm run install-lock       (uses project Conda runtime)
Dev:        npm run tomori | npm run nijika | npm run konata | npm run gopher | npm run msg-archive
            (register slash commands: npm run register)
Test:       npm run test               (subsets: test:unit | test:int | test:contract | test:i18n | test:tools)
Lint:       npm run lint               (format check: npm run format:check)
Type-check: npm run typecheck          (tsc -p tsconfig.strict.json)
Build:      npm run typecheck:emit     (declaration build; runtime is ts-node, no bundling step)
Services:   npm run deploy:prepare | npm run deploy | npm run undeploy
Codegen:    npm run handlers:gen       (after adding or deleting a handler)
```

Runtime and deployment operations: [`docs/contributing/deployment.md`](docs/contributing/deployment.md).

## Path aliases (`tsconfig.json`)

| Alias          | Resolves to                       |
| -------------- | --------------------------------- |
| `@bot`         | `src/bot/index`                   |
| `@cmd`         | `src/handlers/commands/index`     |
| `@button`      | `src/handlers/buttons/index`      |
| `@modal`       | `src/handlers/modals/index`       |
| `@select-menu` | `src/handlers/select-menus/index` |
| `@reaction`    | `src/handlers/reactions/index`    |
| `@core/*`      | `src/core/*`                      |
| `@plugins`     | `src/plugins/index`               |

## Architectural rules

Four load-bearing rules; a CI gate or a reviewer will catch violations.
The full text of each is in `CONTRIBUTING.md`; the recipes under
`docs/contributing/` walk them through.

1. **No CJK literals in `src/handlers/` or `src/plugins/`.** Use translator keys; add `// i18n-ignore: <reason>` only when the literal is not user-facing.
2. **No `process.env.X` outside `src/core/config/env.ts`.**
3. **No new handler / plugin without a test.**
4. **No code change without its documentation.** A change to user-visible behaviour, a config field, a public contract, or a command must update every documentation surface it touches — `docs/architecture.md`, `README.md`, `CONTRIBUTING.md` and the guides under `docs/contributing/`, and the matching `config.example.json` — in the same commit. A missing doc update is a defect, like a missing test. `CHANGELOG.md` is the exception: it is not touched by routine commits and is written in one pass when a release is cut, one entry per notable commit since the last tag (see [`CONTRIBUTING.md`](CONTRIBUTING.md)).

## Quality gates (non-negotiable)

This set mirrors the GitHub CI jobs (`.github/workflows/ci.yml`) and is a
**hard commit gate: every check must pass locally before you commit** — never
commit on a red or unrun gate.

```bash
npm run typecheck
npm run typecheck:emit
npm run lint
npm run format:check
npm run handlers:gen:check
npm run test
npm run test:coverage
npm run knip
npm run security
```

Two CI checks cannot run locally — **`gitleaks`** (secret scan) and CodeQL —
and run only on GitHub. A `dev` commit triggers the full CI on push, so after
committing you MUST confirm that CI run is green (`gh run list --branch dev`)
and fix any red immediately — CI is a gate, not a passive signal.

No `--no-verify`, no skipped tests, no loosened assertions. If a gate fails,
root-cause it; do not bypass.

## Commit protocol

- **Commit only when the user explicitly asks — then commit AND push together.** Do not auto-commit (or `git commit --amend`) after making changes, completing a task, or fixing review-gate / stop-hook findings — make the edits, run the gates, report, and wait for an explicit "commit" instruction. When the user does ask, push to `dev` in the same step; `git push` is part of the commit action, not a separate authorisation. A one-off "commit this" authorises that commit and its push only.
- Commits are small and focused: `<type>(<scope>): <subject>` where `<type>` is `feat`, `fix`, `refactor`, `chore`, `docs`, or `test`. The body explains the why.
- Routine work is committed **directly to `dev`** — no per-change branch or PR. PRs are required only for `dev` → `main` releases and hotfixes, and are optional for large / risky `feature/*` work. The full branching model is in `docs/contributing/branching-and-releases.md`.
