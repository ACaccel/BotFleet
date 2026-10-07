# Contributing

Start with [local setup](docs/contributing/local-setup.md) and the
[architecture overview](docs/architecture.md).

| Task               | Guide                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------- |
| Add a command      | [Handlers, autocomplete, and shared utilities](docs/contributing/adding-a-command.md) |
| Add a plugin       | [Lifecycle and dependency injection](docs/contributing/adding-a-plugin.md)            |
| Change persistence | [Models and repositories](docs/contributing/persisted-models.md)                      |
| Deploy services    | [Runtime, systemd, cutover, and recovery](docs/contributing/deployment.md)            |
| Operate bots       | [Smoke checks, database recovery, and migration](docs/contributing/operations.md)     |
| Commit or release  | [Branching and changelog rules](docs/contributing/branching-and-releases.md)          |

Message archive changes must preserve [exclusive writer ownership, recovery and
source privacy](docs/message-archive.md), including the separation between
[periodic scheduling](docs/message-archive.md#periodic-schedule), live capture and repair jobs.
Archive operator workflows belong to the [Discord control plane](docs/message-archive.md#discord-controls);
keep host migration and unrelated collection cleanup in their existing tools.
Archive summaries must describe actual impacts across the whole manifest and retain
destructive changes, unknown targets and mixed states. Follow the
[compact inspection contract](docs/message-archive.md#review-and-recovery): at most
five buttons, no select menus, two entries per list page and one changes view. Identify affected sources and safe before/after differences without
category, source or individual-operation drilldowns, technical pages or downloads.
Navigation edits its originating public panel. Preserve a live status card only
for its matching item; background updates must not overwrite a panel browsing
another target. Confirmation bindings must identify the displayed message without
moving the job's durable notification reference.
Public source labels require evidence of audience-safe access; never expose raw
recovery images, message bodies or signed URLs.
Guided actions reuse durable jobs and actor-bound confirmations;
presentation changes must not bypass current-state or source-access checks.
Keep the four archive entry points and [deletion lifecycle](docs/message-archive.md#discord-controls)
consistent: stop-and-delete must drain the worker, retain replay tombstones and
preserve archived messages and recovery data for changes that have not been fully
rolled back. Single and bulk plan deletion must share the
[plan eligibility rules](docs/message-archive.md#discord-controls), including conflict,
journal and active-consumer checks for fully rolled-back plans. Whole-list deletion must
retain an exact all-pages snapshot, actor/channel/message-bound consent and
per-item eligibility checks; later arrivals are excluded.
Bulk deletion must bind consent to an exact guild-scoped snapshot, recheck each
item, preserve protected plans and keep shared result/resume controls intact.
Rollback conditional writes must retain an indexable native ID predicate and the
complete-image comparison; preserve recovery order and later-write protection.
Use the [isolated archive benchmarks](tools/archive-benchmark/README.md) for repair,
pipeline, CPU-worker and notification comparisons; never use production messages
as benchmark fixtures. Keep resource limits, durability, dataset identity and
cache mode comparable, and distinguish mock REST ceilings from live API behavior.
The [recorded comparison](docs/contributing/archive-performance-results.md)
states its dataset, resource scope and remaining measurement limits.

## Quality gates

Thread moderation changes must preserve the
[event-gating and persistence contract](docs/thread-moderation.md#implementation-contract),
including bot/thread isolation and suppression when message deletion fails.
DM review must bind the current admin to the delivered message and atomically
record the decision with its grant. Pagination must recheck authority; external
bot replies require verifiable origin rather than timing or mention heuristics.

Every check below must pass locally before committing. Do not bypass hooks,
skip tests, or loosen assertions to clear a gate.

```bash
npm run typecheck
npm run typecheck:emit
npm run lint
npm run format:check
npm run handlers:gen:check
npm run test:coverage
npm run knip
npm run security
```

`typecheck:emit` checks declaration output; production runs through `ts-node`.
`test:coverage` runs all six Vitest projects and their coverage thresholds.
For focused development, use `test:unit`, `test:int`, `test:contract`,
`test:i18n`, or `test:tools`; these do not replace the full gate.
`npm run format` applies formatting fixes.

[Git hooks](docs/contributing/local-setup.md#local-git-hooks) run staged checks
and the local gates before pushing to `dev`. After pushing, confirm GitHub CI
is green with `gh run list --branch dev` and fix failures. Gitleaks and CodeQL
run on GitHub only. The live `npm run smoke` check is separate from CI; see
[operations](docs/contributing/operations.md#pre-deploy-smoke).

## Architectural rules

1. **Use translator keys for user-facing text.** CJK literals in
   `src/handlers/` and `src/plugins/` are rejected. Catalogs live in
   `src/i18n/locales/<lang>/{commands,errors,replies}.json`.
   `// i18n-ignore: <reason>` is only for non-user-facing literals.
2. **Read environment variables through `src/core/config/env.ts`.** Do not
   access `process.env.X` elsewhere, including tools; existing file-log
   overrides have explicit inline exceptions.
3. **Test new handlers and plugins.** New public functions in `core/` and
   `plugins/` need happy-path and error-path tests. Repository methods need
   integration tests against `mongodb-memory-server`.
4. **Update affected documentation with the code.** Keep user behavior,
   configuration, public contracts, commands, and matching
   `config.example.json` files current in the same commit. Link to the
   authoritative guide instead of duplicating it. Update `CHANGELOG.md` only
   at release time, following the [release rules](docs/contributing/branching-and-releases.md#releasing).

## Reporting a security vulnerability

Report suspected vulnerabilities privately through
[GitHub Security Advisories](https://github.com/ACaccel/BotFleet/security/advisories/new),
including affected paths, reproduction conditions, and impact. Do not open a
public issue.

For grouped command routing and internal action modules, see the
[command recipe](docs/contributing/adding-a-command.md#grouping-related-actions).
