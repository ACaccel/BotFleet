# Local setup and development loop

Part of the [contributing guide](../../CONTRIBUTING.md).

## Prerequisites

Install Conda / Miniforge and, for persistent bots, a development MongoDB instance.
Integration tests use `mongodb-memory-server`.

```bash
git clone git@github.com:ACaccel/BotFleet.git
cd BotFleet
CONDA_EXE="$HOME/miniforge3/bin/conda" bash scripts/setup-env.sh
export PATH="$PWD/.conda/bin:$PATH"
```

Setup installs the pinned runtime and fonts from [`environment.yml`](../../environment.yml),
locked dependencies, and verifies Canvas. Commands use `.conda`; activation is optional.
Vitest 3 uses the scoped Tinypool 2.1.2 override in `package.json` to include its
prototype-pollution fixes. Tinypool 2 requires Node 20 or later; the project uses
Node 22. Keep the override until the selected Vitest release depends on a patched
pool, and run the full coverage suite after changing it.

Use `npm run install-lock` to reinstall dependencies or `npm run setup` to update
the environment. Runtime changes require undeploying [managed services](deployment.md).

## Local Git hooks

Install once per clone; the installer refuses to overwrite custom hooks:

```bash
bash scripts/install-hooks.sh
```

Hooks check staged whitespace and [commit messages](branching-and-releases.md#commit-conventions).
Pushing a clean, checked-out commit to `dev` runs the
[quality gates](../../CONTRIBUTING.md#quality-gates); confirm GitHub CI afterward.

The push hook clears repository-local Git environment variables before running
gates so tests can create isolated repositories without changing this checkout.

## Dependency analysis

`npm run knip` uses Knip 6. Its configuration declares `systemd-analyze` and
`mkfifo` as host-provided test utilities, not npm dependencies. Keep the schema
major aligned with the installed tool; Knip 6 no longer supports the
`classMembers` rule. Helper types used only within their defining module stay
unexported; exported interfaces still expose their structural member types.

## Per-personality configuration

```bash
cp src/bot/nijika/config.example.json src/bot/nijika/config.json
```

Create `src/bot/nijika/.env` with `TOKEN`, `CLIENT_ID`, and required feature
credentials. Keep both files out of version control; see [configuration](../configuration.md).

## Running a personality

```bash
npm run nijika # or konata / tomori / gopher / msg-archive
```

## Registering slash commands

Register separately from deployment; pass arguments after `--`:

```bash
npm run register -- -t nijika --dry-run
npm run register -- -t nijika --dev-guild <guild_id>
npm run register -- -t nijika
```

`--dry-run` previews names and descriptions in `config.language` without Discord
writes. Use `--dev-guild` for testing; global changes may take an hour to propagate.
**Global registration prunes guild commands in every guild** to prevent stale overrides.
Use `--keep-guild-commands` to preserve them or `--cleanup-guild-commands` to remove
only guild registrations. Traversal is rate-limited; allow time on large bots.
