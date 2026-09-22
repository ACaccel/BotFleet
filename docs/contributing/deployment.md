# Runtime and systemd deployment

Part of the [contributing guide](../../CONTRIBUTING.md).

## Runtime setup

```bash
CONDA_EXE="$HOME/miniforge3/bin/conda" bash scripts/setup-env.sh
export PATH="$PWD/.conda/bin:$PATH"
```

The application environment is defined by `environment.yml` (Node 22.13.0).
Setup installs npm 10.9.2 and rebuilds native dependencies with `npm ci` using
`package-lock.json`. `BOTFLEET_CONDA_PREFIX` selects another absolute Conda prefix;
otherwise scripts use the checkout's `.conda`. The runtime must have no
unhandled activation hooks. Invalid or missing environments fail explicitly.
The system Node is only a bootstrap option; application code uses the
selected Conda Node. Systemd uses its absolute path and explicit PATH.
Both manual commands and deployed services require their configured Conda
runtime directories to remain available. Systemd does not run `conda activate`
or depend on the environment activated in your terminal. The bot units launch
Node directly; npm is used for installation and management commands.

Set up the independent database runtime without moving existing data:

```bash
CONDA_EXE="$HOME/miniforge3/bin/conda" bash scripts/setup-mongo.sh "$HOME/mongodb-botfleet/.conda"
```

Its definition pins MongoDB 7.0.34 and database tools 100.13.0; setup installs
mongosh 2.10.0. The setup command neither starts MongoDB nor creates a data
directory. Both setup scripts refuse to mutate their managed deployed
runtime. Retain the old environment through cutover validation.

## Local configuration

Copy `deployment.example.json` to the gitignored `deployment.json` and edit
it for this host. Run deployment as the configured ordinary service user;
system operations request sudo. Do not run the CLI as root.

| Field                     | Meaning                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `user`                    | Existing ordinary OS user; must match the invoking user                                   |
| `bots`                    | Unique list of supported personality directory names                                      |
| `runtimePrefix`           | Optional absolute application Conda prefix; otherwise launcher prefix or project `.conda` |
| `readinessTimeoutSeconds` | Per-service readiness budget, 15–600 seconds; default 120                                 |
| `mongodb.prefix`          | Absolute independent MongoDB Conda prefix                                                 |
| `mongodb.configFile`      | Existing MongoDB configuration, currently JSON syntax; preserved verbatim                 |
| `mongodb.probeEnvFile`    | Private bot `.env` containing the authenticated `MONGO_URI` used for readiness            |

Omit `mongodb` when the database is managed elsewhere. Each bot with a
configured `MONGO_URI` still gets a bounded database probe before starting.
Secrets remain in per-bot `.env` files, outside version control. Do not put
credentials in deployment.json or command-line arguments.

MongoDB preparation preserves the existing absolute `storage.dbPath`,
authentication, localhost binding, and log settings. It saves the original
configuration in the prepared directory and generates a separate foreground
configuration with `fork: false` and no PID file. The installed database unit
uses that generated configuration; the original config remains available
for manual rollback. This workflow assumes an existing, initialized local
database, not provisioning a new database or rotating credentials.

## Commands

```bash
npm run register -- -t nijika           # Discord command registration
npm run register -- -t nijika --dry-run # No Discord writes
npm run mongo:prepare               # Preview the independent database unit
npm run deploy:prepare              # Type-check, snapshot, and preview bot units
npm run mongo:deploy                # Install/start/enable the database unit
npm run deploy                      # Install/update/start/enable selected bots
npm run undeploy                    # Remove managed bot units
npm run mongo:undeploy              # Remove database unit; requires bots undeployed
npm run deploy:recover              # Recover an interrupted service transaction
```

Use `npm run register -- -t ...` for Discord command registration.
Unexpected arguments on deployment commands fail with migration guidance.
Service deployment never implicitly registers Discord commands. A normal
code update uses `npm run deploy` directly; it does not require undeploy first.
To restart one deployed bot without updating its release:

```bash
sudo systemctl restart botfleet@nijika.service
systemctl status botfleet@nijika.service
journalctl -u botfleet@nijika.service -f
```

The database service is `mongodb-botfleet.service`. Bot units use that
service for ordering when local MongoDB is configured. Explicit database
probes provide readiness rather than relying on unit ordering alone.

## Prepared releases and readiness

Preparation does not start services or log into Discord. It validates the
runtime and settings, checks types for bot releases, copies source and
node_modules into `.deploy/releases/<id>`, verifies native canvas loading,
and runs `systemd-analyze verify`. Review `manifest.json` and the generated
units there. A normal deploy prepares a fresh release before switching.

Source and dependencies are copied, not hard-linked to the checkout. Local
ignored files under `src` (including `.env` and `config.json`) are linked to
their original locations, so configuration updates remain persistent.
`data`, `logs`, and `errors` also remain shared. Release directories are
private to the service user and retained after undeploy; they can contain
private configuration snapshots. Do not delete a directory referenced by
an installed unit or recovery journal.

Systemd creates `/run/botfleet-<bot>/` before startup. The bot atomically
writes its startup attestation after Discord, guild repositories, and
plugins are ready. Deployment checks the marker PID and timestamp against
the active systemd process. The archive worker starts its first backup in the background; readiness does
not wait for the history walk to finish. This is startup verification, not a continuous
health endpoint. Process crashes restart automatically; database recovery
continues to use the application's existing retry behavior.

## Initial cutover

1. Verify a recoverable database backup and keep the old runtime/configuration.
2. Prepare both kinds of unit, inspect the paths/user/bot list and generated
   MongoDB configuration, and complete isolated tests.
3. During the maintenance window, stop the old bot processes gracefully.
   Stop all database writers before stopping the old MongoDB process.
4. Confirm the old MongoDB has exited, then deploy its unit and check the
   authenticated readiness result. Deploy bots and verify their normal work.
5. Check service enablement with `systemctl is-enabled`. Schedule a real
   reboot test separately; enablement alone is not proof of a successful reboot.

Deployment refuses known unmanaged bot processes and an unmanaged MongoDB
process. It does not automatically kill tmux sessions or production
processes. The first failed cutover may need manual restart of the old
processes; automatic rollback only covers previously managed services.

## Recovery and removal

Only units bearing this checkout's ownership marker are managed. Existing
unmanaged units, symlinks, and drop-in overrides are rejected. Deployments
are serialized using a lock. Before changing services, a durable transaction
journal records old unit definitions, enabled/active state, and manifests.

An ordinary failure restores old units, reinstates their enabled/active
state, and verifies restarted services. A crash/interruption leaves a journal;
run `npm run deploy:recover` before retrying. If rollback itself fails, keep the
journal and inspect the service logs before recovery. A transaction whose
manifest was already committed is finalized without reverting its services.

Rollback restores code/dependencies and service definitions. It does not
revert edits to shared `.env`/configuration, external actions, or database
contents. Runtime updates require undeploy first; restarting a release after
a runtime change is not a guaranteed rollback to that old runtime.

Bot undeploy never stops the database or removes its data. Database undeploy
is separate and also preserves all data, settings, environments, and
releases. Migration export excludes Conda environments and deployment state;
see [migration recovery](../../tools/migration/README.md) for rebuilding on
another host. No automatic reboot or old-environment deletion is performed.
