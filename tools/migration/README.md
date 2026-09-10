# Migrate databases and local files

Git clone supplies the application code. This tool moves **all application
MongoDB databases** and **gitignored files** such as `.env`, `config.json`,
`logs/`, `data/`, and tool backups. It excludes `node_modules`, build/coverage
output, `.plan`, and migration settings/state. MongoDB `admin`, `config`, and
`local` internals are excluded; the shared application user is recreated.

## Configuration: source only

Copy `config.example.json` to `config.json` beside this README:

| Field         | Meaning                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `environment` | Full conda environment path, e.g. `/home/guest/miniforge3/envs/botfleet`. If omitted, use the active conda environment.                |
| `mongoEnv`    | Bot `.env` providing `MONGO_URI`, relative to the Git checkout. Defaults to `src/bot/tomori/.env`. No password belongs in this config. |
| `backupDir`   | Parent directory for automatically named backups, outside the repository. Defaults to `botfleet-backups` beside the checkout.          |

Paths are literal: use absolute paths for `environment` and `backupDir`, not `~`.
No target config is needed after activating its conda environment. Versions and
all application database names are discovered during export.

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
copied installer). It does not need conda, Node, MongoDB, Yarn, or Git installed.
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
Node, Yarn and mongosh versions come from the backup. No manual version list is
needed. Use `--prefix /absolute/conda` if conda belongs elsewhere; activate that
installation afterward. Reusing an environment can update its packages.

## 3. Restore and run

Inside the clean clone, with `dc` active:

```bash
bash ~/botfleet-backup/tool/migration.sh restore ~/botfleet-backup
```

One command installs locked application dependencies, restores ignored files,
creates a dedicated local MongoDB, restores every application database and
verifies counts, views, indexes and file checksums. Existing runtime files or a
MongoDB destination are never overwritten. The MongoDB directory defaults to
`mongodb-<checkout-name>` beside the checkout; override with `--mongo-dir PATH`.
The source MongoDB port must be available. Auth stays enabled, bound to localhost;
application credentials and `.env` contents are preserved.

MongoDB remains running; start the desired bots with their usual `yarn tomori`,
`yarn nijika`, etc. Update webhook/API routing if used. No slash-command
registration is needed. There is no bot process manager or reboot automation.
After reboot, activate `dc`, run `mongod --config PATH_PRINTED_BY_RESTORE`, then
start the bots. To recheck before bot startup:

```bash
bash ~/botfleet-backup/tool/migration.sh verify ~/botfleet-backup
```

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

Tests: `yarn test:tools tools/migration`. For an isolated real MongoDB drill, set
`MIGRATION_TEST_BIN_DIR` to a directory containing the database binaries and put
`mongosh` on PATH. Tests never use the production database or bot credentials.
