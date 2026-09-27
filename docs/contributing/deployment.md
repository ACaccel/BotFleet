# Runtime and systemd deployment

Part of the [contributing guide](../../CONTRIBUTING.md).

## Runtime setup

Set up the application using [local setup](local-setup.md#prerequisites).
`BOTFLEET_CONDA_PREFIX` can select another absolute Conda prefix instead of
`.conda`. Services launch that runtime's Node directly, without shell activation;
keep its directory available while deployed.

For a managed local database, create an independent runtime:

```bash
CONDA_EXE="$HOME/miniforge3/bin/conda" bash scripts/setup-mongo.sh "$HOME/mongodb-botfleet/.conda"
```

This installs the versions defined by the database setup files; it does not
start MongoDB or create/move data. Both setup scripts refuse to modify a
managed deployed runtime. Keep the old environment until cutover is validated.

## Local configuration

Copy `deployment.example.json` to gitignored `deployment.json`. Run commands
as the configured ordinary service user; system operations request sudo.
Do not run the deployment CLI as root.

| Field                     | Meaning                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `user`                    | Existing ordinary OS user; must match the invoking user                                   |
| `bots`                    | Unique supported personality directory names                                              |
| `runtimePrefix`           | Optional absolute application Conda prefix; otherwise launcher prefix or project `.conda` |
| `readinessTimeoutSeconds` | Per-service readiness budget, 15–600 seconds; default 120                                 |
| `mongodb.prefix`          | Absolute independent MongoDB Conda prefix                                                 |
| `mongodb.configFile`      | Existing MongoDB configuration in JSON syntax                                             |
| `mongodb.probeEnvFile`    | Private bot `.env` with authenticated `MONGO_URI` for readiness                           |

Omit `mongodb` for an externally managed database. Bots with `MONGO_URI` still
receive a bounded database probe. Keep credentials in private `.env` files,
never in deployment settings or command arguments.

This workflow uses an existing, initialized database. Preparation preserves
its absolute `storage.dbPath`, authentication, localhost binding, and log
settings. It saves the original config and generates a foreground copy with
`fork: false` and no PID file for systemd. It does not provision databases
or rotate credentials.

## Commands

```bash
npm run mongo:prepare  # Preview database unit
npm run deploy:prepare # Type-check, snapshot, and preview bot units
npm run mongo:deploy   # Install/start/enable database unit
npm run deploy         # Prepare and deploy selected bots
npm run undeploy       # Remove managed bot units
npm run mongo:undeploy # Remove database unit after bots are undeployed
npm run deploy:recover # Recover an interrupted transaction
```

For a normal code update, run `npm run deploy` without undeploying first.
[Discord command registration](local-setup.md#registering-slash-commands) is a
separate operation. To restart or inspect a deployed bot:

```bash
sudo systemctl restart botfleet@nijika.service
systemctl status botfleet@nijika.service
journalctl -u botfleet@nijika.service -f
```

The database unit is `mongodb-botfleet.service`.

## Prepared releases and readiness

Preparation validates configuration/runtime, type-checks bot releases, copies
source and dependencies into `.deploy/releases/<id>`, checks Canvas rendering,
and runs `systemd-analyze verify`. It does not start services or log in to
Discord. Review the generated units and `manifest.json` before cutover.

Ignored source configuration files are linked to the checkout; `data`, `logs`,
and `errors` remain shared. Releases are private to the service user and may
contain private configuration snapshots. Do not delete releases referenced by
installed units or recovery journals; undeploy retains them.

Deployment probes MongoDB and checks a startup marker against the active
systemd process after Discord, repositories, and plugins are ready. Archive
history backup continues in the background. Readiness verifies startup, not
continuous health; systemd restarts crashed processes.

## Initial cutover

1. Verify a recoverable database backup and keep the old runtime/configuration.
2. Prepare both unit types, inspect paths, user, bot list, and MongoDB config,
   and complete isolated validation.
3. In a maintenance window, stop old bots gracefully. Stop all database writers
   before stopping MongoDB.
4. Confirm the old MongoDB exited, deploy its unit, verify authenticated
   readiness, then deploy bots and check their normal work.
5. Check `systemctl is-enabled`; schedule a real reboot test separately.

Deployment rejects known unmanaged bot/MongoDB processes rather than killing
them. Automatic rollback covers previously managed services only; a first
cutover failure may require restarting old processes manually.

## Recovery and removal

Only this checkout's owned units are managed; unmanaged units, symlinks, and
drop-in overrides are rejected. A lock serializes deployment, and a durable
journal records service state before changes.

Ordinary failures restore prior units and enabled/active state, then verify
restarted services. After a crash/interruption, run `npm run deploy:recover`
before retrying. If rollback fails, preserve the journal and inspect logs.
Transactions already committed to the manifest are finalized without reverting.

Rollback restores code, dependencies, and unit definitions. It does **not** undo
shared configuration edits, database writes, or external actions. Runtime
updates require undeploying first; an older release does not restore an older
runtime automatically.

Bot undeploy leaves MongoDB running. Database undeploy preserves data, settings,
environments, and releases. Migration exports exclude Conda environments and
deployment state; follow the [migration runbook](../../tools/migration/README.md)
on another host. No automatic reboot or environment deletion occurs.
