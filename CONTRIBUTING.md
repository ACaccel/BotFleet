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

## Quality gates

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
