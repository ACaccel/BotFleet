# Migrate databases and local files

Git clone supplies the application code. This tool moves **all application
MongoDB databases** and **gitignored files** such as `.env`, `config.json`,
`logs/`, `data/`, and tool backups. It excludes `node_modules`, build/coverage
output, `.plan`, `.conda`, `.deploy`, `deployment.json`, and migration settings/state. MongoDB `admin`, `config`, and
`local` internals are excluded; the shared application user is recreated.

## Configuration: source and split targets

Copy `config.example.json` to `config.json` beside this README:

| Field                 | Meaning                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment`         | Application conda environment path, e.g.`/home/guest/miniforge3/envs/botfleet`. If omitted, use the active conda environment.                       |
| `databaseEnvironment` | MongoDB runtime prefix containing `mongod`, `mongodump`, `mongorestore`, and `mongosh`. Defaults to `environment` for combined legacy environments. |
| `mongoEnv`            | Bot`.env` providing `MONGO_URI`, relative to the Git checkout. Defaults to `src/bot/tomori/.env`. No password belongs in this config.               |
| `backupDir`           | Parent directory for automatically named backups, outside the repository. Defaults to`botfleet-backups` beside the checkout.                        |

Paths are literal: use absolute paths for both environments and `backupDir`, not `~`.
The application environment may be `<checkout>/.conda`; the database environment
must remain outside the checkout unless it is the same legacy combined environment.
Binaries must exist in their configured prefix; no system/PATH fallback is used.
No target config is needed for an active combined environment. A split target
must pass `--config /absolute/target-config.json` on restore and verify.
Versions and all application database names are discovered during export.

A **backup** is one directory containing the database dump, ignored files,
checksums and a small recovery tool. The tool stores locks and completion records
inside Git's local metadata directory.

## 1. Export on the source

Run inside the current checkout. Preview the database names and included files:

```bash
bash tools/migration/migration.sh inspect
```

Stop bots, backup jobs and automatic restarts. Keep MongoDB running, then:

```bash
bash tools/migration/migration.sh export --writers-stopped
```

This creates a new directory under `backupDir` and prints its path and source
Git commit. It never stops processes for you. Keep every database/file writer
stopped until cutover. Tracked changes and untracked nonignored files are not
backed up: publish the desired application revision through Git separately.

Copy the printed directory over SSH (replace the path, account and port):

```bash
scp -P SSH_PORT -r /absolute/printed-backup-directory USER@HOST:~/botfleet-backup
```

Use a destination that does not already exist. The backup contains secrets;
keep it private. Partial exports have no valid manifest and cannot be restored.

## 2. Prepare the target and clone

The target needs Linux/glibc, Bash, coreutils, tar, and curl or wget (or a locally
copied installer). It does not need conda, Node, MongoDB, npm, or Git installed.
Bootstrap installs these and native build dependencies without sudo:

```bash
bash ~/botfleet-backup/tool/bootstrap.sh --env dc \
  --runtime ~/botfleet-backup/runtime.conf --apply
source ~/miniforge3/etc/profile.d/conda.sh
conda activate dc
git clone YOUR_REPOSITORY_URL ~/BotFleet
cd ~/BotFleet
git checkout SOURCE_COMMIT_PRINTED_BY_EXPORT
```

Omit `--apply` to preview. The Miniforge release is pinned in
`bootstrap-runtime.conf`; its installer and SHA256 are fetched from that fixed
[official release](https://github.com/conda-forge/miniforge/releases). Database,
Node, npm and mongosh versions come from the backup. No manual version list is
needed. Backups exported before the npm transition retain their bundled Yarn-based
recovery tool; use that bundled tool with the recorded source commit. Do not mix
its runtime inventory with a newer bootstrap. Use `--prefix /absolute/conda` if
conda belongs elsewhere; activate that installation afterward. Reusing an
environment can update its packages.

## 3. Restore and run

Inside the clean clone, with `dc` active:

```bash
bash ~/botfleet-backup/tool/migration.sh restore ~/botfleet-backup
```

One command installs locked application dependencies, restores ignored files,
creates a dedicated local MongoDB, restores every application database and
verifies counts, views, indexes and file checksums. Existing runtime files or a
MongoDB data or configuration are never overwritten. A pre-created MongoDB
destination is accepted only when it contains exactly the configured `.conda`
database runtime and no other entries. The MongoDB directory defaults to
`mongodb-<checkout-name>` beside the checkout; override with `--mongo-dir PATH`.
The source MongoDB port must be available. Auth stays enabled, bound to localhost;
application credentials and `.env` contents are preserved.

MongoDB remains running; bots are not started. Update webhook/API routing if used.
No slash-command registration is needed. This recovery tool does not install
systemd services. For temporary combined-environment operation, set
`BOTFLEET_CONDA_PREFIX="$CONDA_PREFIX"` before bot commands only if that runtime satisfies the launcher version checks and has no activation hooks. Otherwise complete the split setup below before starting bots.
For persistent deployment, complete the split-runtime transition below and follow
the [operations guide](../../docs/contributing/operations.md). To recheck before bot startup:

```bash
bash ~/botfleet-backup/tool/migration.sh verify ~/botfleet-backup
```

## Split-runtime recovery

Export supports the split layout directly with the example configuration. Backup
`runtime.conf` records application and database versions independently; neither
Conda binaries nor machine-specific systemd deployment state are copied.

The portable bootstrap intentionally retains its combined-environment interface.
It can recover a split source using the same steps above: bootstrap a dedicated
combined environment from the backup's exact version inventory, clone the source
commit, restore, then verify before starting bots. Both combined and split
export/restore paths are covered by the isolated MongoDB drill.

To transition the recovered host to the normal split layout:

1. Run `npm run setup` to build the checkout's `.conda` application runtime and locked
   native dependencies. Keep the recovery environment available for rollback.
2. Run `bash scripts/setup-mongo.sh /absolute/mongodb-botfleet/.conda` to prepare
   the independent database runtime. Confirm its versions match `runtime.conf`;
   do not combine this transition with a database upgrade.
3. Update local migration configuration to the new application and database
   prefixes. Preserve the restored data path, MongoDB configuration, and credentials.
4. Follow the operations guide to prepare/review systemd deployment, stop the
   recovery server cleanly, and cut over once. Do not run two servers against
   the same `dbPath`. Validate readiness before enabling bots.

Alternatively, prepare both runtimes at the exported versions before restoring,
set `environment` and `databaseEnvironment` in an external target config, and
pass it to restore and verify. The database parent may already contain `.conda`
only; existing `data`, logs, or configuration cause restore to fail closed.

## Failure and rollback

A failed restore stops only the MongoDB it started and retains partial files.
Use a fresh clone/MongoDB destination to retry; do not remove data to bypass a
conflict. A killed process may leave a lock under `.git/botfleet-migration/`;
remove it only after confirming its processes have exited. Keep the source
until the target works. Rollback after target writes requires reconciling those
new writes first; never run both hosts with the same bot tokens.

Standalone local MongoDB with a shared `admin`-authenticated application
credential is supported. Replica sets, sharding, other administrative users,
and version upgrades are outside scope. Database verification compares counts
and metadata, not each document's content; complete writer shutdown is required.

Tests: `npm run test:tools -- tools/migration`. For an isolated real MongoDB drill, set
`MIGRATION_TEST_BIN_DIR` to a directory containing the database binaries and put
`mongosh` on PATH. Tests never use the production database or bot credentials.
