# Contributing

Tomori and Nijika feature changes must honor the [guild settings contract](docs/tomori-settings.md)
in every relevant command, component, message event and destination path. Preserve
completion/cleanup for active items and enforce field authority in the application
service; hiding a panel control is not authorization. Native channel/role select
handlers declare supported component types in the shared select-menu contract.
Modal submissions bind their context to the owner-bound one-use nonce. Preserve
per-guild asynchronous locale/time-zone context across delayed work; never mutate
shared translator defaults. Changes to voting must retain fresh human-member and
role eligibility checks and Discord timeout authority. Tomori earthquake changes
must preserve [opt-in delivery and optional-role semantics](docs/tomori-settings.md#earthquake-notifications),
including settings rechecks before an update can mention a role.

Start with [local setup](docs/contributing/local-setup.md) and the
[architecture overview](docs/architecture.md).

Changes to `/gay` must preserve the [daily fun reading contract](docs/fun-readings.md),
including optional archive inputs, permission-scoped snapshots and query budgets.

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
[periodic scheduling](docs/message-archive.md#periodic-schedule), live capture and the
[full backup](docs/message-archive.md#full-backup).
Archive operator workflows belong to the [Discord control plane](docs/message-archive.md#discord-controls);
keep host migration and unrelated collection cleanup in their existing tools.
Every `/archive` command and button must recheck the `admin` list, `backup_server`, the
debug channel and msg-archive ownership, and reject privately without changing the
shared panel. Custom-ID prefixes of retired panels stay registered only to reply
privately that the panel is stale ([`retired-archive-controls.ts`](src/handlers/retired-archive-controls.ts));
they perform no action. Only starting a full backup asks for confirmation; it stays bound to the
operator, channel and message and returns its existing job on replay. Panels render
from durable records through the shared application renderer; the worker may edit only a
backup's own panel and must leave an open detail page alone. A full backup keeps its
cutoff and its own checkpoints through stops and restarts, settles Gateway continuity
against its first-start origin, and completes with known gaps. A single message's
reaction failure marks only that message stale. Panels never show message bodies,
raw errors or signed URLs.
Conditional writes must retain an indexable native ID predicate and the
complete-image comparison; verify candidate selection with MongoDB execution stats,
not only small-fixture correctness. Empty reaction optimizations must retain
observation fencing before every write wave and remove old membership references.
Snapshot batching must flush repeated identities, write each message and its edit
history in one replacement, verify target images before checkpointing, and pass
partial-write/resume tests. Message documents follow the schema 3 contract in
[message archive](docs/message-archive.md#message-documents); a normalizer change
must keep the schema contract test passing. Progress changes must exclude restored
work from recent throughput.
Use the [isolated archive benchmarks](tools/archive-benchmark/README.md) for
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
run on GitHub only. A verified Gitleaks false positive that history keeps goes
into `.gitleaksignore` as its exact fingerprint with the reason; do not widen
`.gitleaks.toml` for it. A separate workflow runs the isolated MongoDB
[migration drill](tools/migration/README.md#tests), which `test:coverage` skips
without database binaries, when its inputs change and weekly. The live `npm run smoke` check is separate from CI; see
[operations](docs/contributing/operations.md#pre-deploy-smoke).

## Architectural rules

1. **Use translator keys for user-facing text.** CJK literals in
   `src/handlers/`, `src/plugins/`, `src/application/`, `src/bot/` and
   `src/infra/` (the directories `test/i18n/no-literal-cjk.test.ts` scans) are rejected. Catalogs live in
   `src/i18n/locales/<lang>/{commands,errors,replies}.json`.
   `// i18n-ignore: <reason>` is only for non-user-facing literals.
2. **Read environment variables through `src/core/config/env.ts`.** Do not
   access `process.env.X` elsewhere, including tools; existing file-log
   overrides have explicit inline exceptions.
3. **Test new handlers and plugins.** New public functions in `core/`,
   `application/` and `plugins/` need happy-path and error-path tests. Repository methods need
   integration tests against `mongodb-memory-server`.
4. **Update affected documentation with the code.** Keep user behavior,
   configuration, public contracts, commands, and matching
   `config.example.json` files current in the same commit. Link to the
   authoritative guide instead of duplicating it. Update `CHANGELOG.md` only
   at release time, following the [release rules](docs/contributing/branching-and-releases.md#releasing).

ESLint also enforces the [layer boundaries](docs/architecture.md#layers-and-boundaries).
Discord renderers use the shared [presentation color rules](docs/architecture.md#discord-presentation-colors).

## Reporting a security vulnerability

Report suspected vulnerabilities privately through
[GitHub Security Advisories](https://github.com/ACaccel/pleiades-fleet/security/advisories/new),
including affected paths, reproduction conditions, and impact. Do not open a
public issue.

For grouped command routing and internal action modules, see the
[command recipe](docs/contributing/adding-a-command.md#grouping-related-actions).
