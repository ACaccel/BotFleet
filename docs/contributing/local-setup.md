# Local setup and development loop

Part of the [contributing guide](../../CONTRIBUTING.md).

## Prerequisites

Install Conda / Miniforge and provide a development MongoDB instance if the
personality uses persistence. Integration tests use `mongodb-memory-server`.

```bash
git clone git@github.com:ACaccel/BotFleet.git
cd BotFleet
CONDA_EXE="$HOME/miniforge3/bin/conda" bash scripts/setup-env.sh
export PATH="$PWD/.conda/bin:$PATH"
```

Setup installs the runtime from `environment.yml` (Node 22.13.0 and Noto Sans
CJK TC), npm 10.9.2, and locked dependencies, then verifies Canvas rendering.
Commands use the project's `.conda` runtime; activation is optional.
Use `npm run install-lock` to reinstall dependencies and `npm run setup` to
update the environment. Setup refuses runtime changes while managed bot
services are deployed; see [deployment](deployment.md).

## Local Git hooks

Review existing hooks, then install the versioned hooks once per clone:

```bash
bash scripts/install-hooks.sh
```

The installer refuses to overwrite custom hooks. `pre-commit` checks staged
whitespace, `commit-msg` checks the [commit convention](branching-and-releases.md#commit-conventions),
and `pre-push` runs the full [quality gates](../../CONTRIBUTING.md#quality-gates)
for a clean, checked-out commit pushed to `dev`. Confirm GitHub CI after pushing.

## Per-personality configuration

```bash
cp src/bot/nijika/config.example.json src/bot/nijika/config.json
```

Create the matching `src/bot/nijika/.env` with `TOKEN`, `CLIENT_ID`, and the
credentials its features require. Keep both local files out of version control.
See the [configuration reference](../configuration.md) for fields and defaults.

## Running a personality

```bash
npm run nijika # or konata / tomori / gopher / msg-archive
```

## Registering slash commands

Command registration is separate from service deployment. Pass arguments after `--`:

```bash
npm run register -- -t nijika --dry-run
npm run register -- -t nijika --dev-guild <guild_id>
npm run register -- -t nijika
```

Use `--dry-run` to inspect names and descriptions without Discord writes, and
`--dev-guild` for fast test-guild iteration. Production uses the default global
registration; global changes may take up to an hour to propagate.

**Global registration also prunes guild-scoped commands in every guild.**
This prevents stale test registrations from overriding the global set.
Use `--keep-guild-commands` to skip pruning, or `--cleanup-guild-commands` to
remove only guild-scoped registrations. Large bots should account for the
rate-limited guild traversal.

Descriptions use `config.language`; the dry run shows the resolved text.
