---
name: contribute-change
description: Standard workflow to add / delete / modify code or docs in this repo: understand the area, plan, implement, self-check against project-conventions and coding-standards, run quality gates, sync the documentation surfaces, commit.
---

# Contribute a Change (contribute-change)

This skill is the standard end-to-end workflow for any contribution
under this repo — adding a slash command, adding a plugin, refactoring
a core module, updating config, or editing public docs. Follow the
eight steps in order. Do not skip a step to save time; each one
prevents a class of regression.

Authoritative public sources:
[`README.md`](../../../README.md),
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md) and the guides under
[`docs/contributing/`](../../../docs/contributing/),
[`AGENTS.md`](../../../AGENTS.md),
[`docs/architecture.md`](../../../docs/architecture.md).

## Step 1 — Understand the area

- Read `docs/architecture.md` for the layer in which the change lands
  and the abstraction it touches.
- Read the source of the contract itself — the interface, the schema, or
  the plugin factory. `docs/architecture.md` describes the shape; the
  code is the authority.
- Use `Read` / `Grep` / `Glob` to locate the files involved; map every
  inbound import to a layer; identify the contract you are changing.

## Step 2 — Plan

Decide before writing:

- Which layer the change lives in (core / persistence / infra /
  handlers / plugins / bot / scripts / docs / config).
- The smallest set of files that must change.
- The smallest set of tests that must be added or updated.
- Which documentation surfaces the change touches (step 7). Decide this
  up front — a doc update discovered after the gates are green usually
  means the change was scoped wrong.

## Step 3 — Implement

- Apply the rules in [`project-conventions`](../project-conventions/SKILL.md)
  while writing: layer direction, plugin contract, IoC contract,
  Repository pattern, error tree + Result, i18n routing, handler
  codegen + 150-line rule, directory naming, the three load-bearing
  CONTRIBUTING.md rules.
- Apply the rules in [`coding-standards`](../coding-standards/SKILL.md):
  SRP, design-pattern justification, naming, guard clauses, security,
  structured errors, comments, testing discipline.
- After adding or deleting a handler, run `npm run handlers:gen`.

## Step 4 — Self-check

Walk through the section 10 list of `project-conventions` and the
section 9 list of `coding-standards`. Treat any failing item as a
defect and fix it before continuing.

## Step 5 — Dispatch reviewers

Pick the reviewer agents whose scope matches the changed files and
run them in `Audit:` or `Review:` mode against the diff. Reviewer
selection guide:

| Change touches                                    | Reviewer                     |
| ------------------------------------------------- | ---------------------------- |
| `src/core/` or `src/bot/` or new / deleted module | architecture-reviewer        |
| TypeScript types, generics, Result, unions        | type-system-reviewer         |
| Retry, lifecycle, async, partial failure          | reliability-reviewer         |
| Tests or quality gates                            | test-architect               |
| `package.json` / CI / ESLint / tsconfig / secrets | config-and-security-reviewer |
| `src/i18n/locales/` or user-facing strings        | i18n-discipline-reviewer     |

Resolve any BLOCK finding before moving on; treat WARN seriously.

## Step 6 — Run quality gates

Run, until each is green:

```bash
npm run typecheck
npm run lint
npm run test
npm run format:check
npm run handlers:gen:check
npm run knip
```

Do not bypass `--no-verify`, do not skip tests, do not loosen a
threshold. Root-cause any failure.

## Step 7 — Sync the documentation surfaces

Documentation lands in the **same commit** as the code. There are four
surfaces; update each one the change actually touches, and no others —
each fact lives in exactly one place, everywhere else links to it.

| Surface                                  | Update it when                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| `docs/architecture.md`                   | A layer, abstraction, contract, lifecycle order, or design trade-off changed. |
| `README.md`                              | A user-visible feature, an `.env` key, or a `config.json` field changed.      |
| `CONTRIBUTING.md` / `docs/contributing/` | A recipe, convention, quality gate, or architectural rule changed.            |
| `src/bot/<name>/config.example.json`     | A config field was added, removed, renamed, or its default changed.           |

`CHANGELOG.md` is **not** one of them: routine commits leave it alone.
It is written in one pass when a release is cut — walk
`git log <last tag>..HEAD` and file one entry per notable commit under
the new version (`docs/contributing/branching-and-releases.md`,
Releasing). The changelog follows Keep a Changelog. An entry is one
imperative sentence closing with a link to the commit that made it —
`- <Description> ([<7-char hash>](https://github.com/ACaccel/BotFleet/commit/<hash>)).`
— filed under Added / Changed / Fixed / Removed / Security.

The changelog is public and permanent, so every entry obeys four content
rules (full text in `CONTRIBUTING.md`, Architectural rule 4):

- High-level, one sentence, at most two rendered lines — what changed for
  a user or an operator, never class names, paths, catalog keys, or
  rationale.
- No personal, nickname, private-joke, or guild-specific references.
- Keep the **breaking** marker, but point at README for the operator
  step: `(**breaking** — see [`README.md`](README.md))`.
- Shorten and scrub, never drop an entry; merge two entries only when
  they share a commit link.

Missing documentation is a defect, exactly like a missing test.

## Step 8 — Commit (only when the user asks)

- **Do not commit until the user explicitly asks.** Finish the edits,
  run the gates (Step 6), update docs (Step 7), report what changed, and
  stop. Do not auto-commit on task completion or after fixing
  review-gate / stop-hook findings; do not `git commit --amend` a prior
  commit without being asked. A one-off "commit" request covers that
  commit only.
- When asked: produce a small, focused commit. Subject prefix follows
  the conventional-commits style used in this repo (`feat` / `fix` /
  `refactor` / `chore` / `docs` / `test`).
- Commit message body explains the why, not the what.
- No `Co-Authored-By` trailer or any other AI-attribution line.
- Push to `dev` in the same step; a commit request authorises its push,
  and `git push` is part of the commit action rather than a separate
  approval. Do not open a PR unless the user explicitly asks.
