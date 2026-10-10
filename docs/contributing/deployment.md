# Runtime and systemd deployment

## Runtime setup

Follow [local setup](local-setup.md#prerequisites). `BOTFLEET_CONDA_PREFIX` selects
an absolute prefix instead of `.conda`; services use its Node directly. Keep the
runtime available while deployed.

For a managed local database, create an independent runtime:

```bash
CONDA_EXE="$HOME/miniforge3/bin/conda" bash scripts/setup-mongo.sh "$HOME/mongodb-botfleet/.conda"
```

Setup does not start MongoDB or create/move data. Both setup scripts reject
managed deployed runtimes; retain the old environment until cutover is validated.

## Local configuration

Copy [deployment.example.json](../../deployment.example.json) to gitignored
`deployment.json`. Set `user` to the invoking ordinary OS user and `bots` to unique
personality names. Run as that user; system operations request sudo. Do not run as root.

Optional `runtimePrefix` overrides the launcher prefix/project `.conda`;
`readinessTimeoutSeconds` is 15–600 seconds (default 120). For managed MongoDB,
set its absolute `prefix`, an existing JSON-syntax `configFile`, and a private bot
`probeEnvFile` containing authenticated `MONGO_URI`. Omit `mongodb` for an external
database. Keep credentials out of deployment settings and command arguments.

The database must already be initialized. Preparation preserves its absolute
`storage.dbPath`, authentication, localhost binding, and logs, saving the original
config and generating a foreground copy for systemd. It does not provision data
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

For code updates, run `npm run deploy` without undeploying. Register
[Discord commands](local-setup.md#registering-slash-commands) separately. Inspect bots with:

```bash
sudo systemctl restart botfleet@nijika.service
systemctl status botfleet@nijika.service
journalctl -u botfleet@nijika.service -f
```

The database unit is `mongodb-botfleet.service`.

## Prepared releases and readiness

Preparation validates configuration/runtime, types, Canvas and units, then snapshots
source/dependencies in `.deploy/releases/<id>` without starting services. Review units
and `manifest.json` before cutover. Configuration links, `data`, `logs`, and `errors`
are shared. Private releases can contain configuration snapshots; retain any release
referenced by units or recovery journals, including after undeploy.

Each selected bot's local JSON settings are parsed before release copying or service
cutover. For msg-archive, preparation uses the same policy and runtime validators as
plugin startup, including concurrency and notification cadence. Invalid settings
abort preparation with the affected field path; existing units keep running.

Readiness checks MongoDB and the active process after Discord, repositories and
plugins initialize; enabled archive history scans continue in the background. It verifies
startup only. Systemd restarts crashed processes.

For msg-archive, resuming a paused repair is a separate control operation after
readiness. A continuation timeout does not undo a successful deployment. Inspect
whether the original plan already has an active job before retrying only the
continuation. Large-journal operator verification budgets are described in
[archive controls](../message-archive.md#discord-controls); they do not bypass
manifest or confirmation checks.

## Initial cutover

1. Verify a recoverable database backup; retain the old runtime/configuration.
2. Prepare both unit types, review paths/user/bots/database settings, and validate in isolation.
3. Stop old bots gracefully in a maintenance window; stop every database writer before MongoDB.
4. Confirm old MongoDB exited, deploy its unit, verify authenticated readiness, then deploy and check bots.
5. Check `systemctl is-enabled` and schedule a reboot test.

Unmanaged bot/MongoDB processes block deployment. First cutover failures may require
manually restarting old processes; automatic rollback covers managed services only.

## Recovery and removal

Only owned units are managed; unmanaged units, symlinks and drop-ins are rejected.
Failures restore prior units and enabled/active state. After interruption, run
`npm run deploy:recover` before retrying; preserve the journal and inspect logs if
rollback fails. Committed transactions are finalized without reverting.

Rollback restores code/dependencies/units, but not shared configuration, database
writes or external actions. Runtime updates require undeploying first; releases do
not restore runtimes. Bot undeploy leaves MongoDB running; database undeploy preserves
data, settings, environments and releases. For host transfer, follow
[migration](../../tools/migration/README.md); exports exclude runtimes and deployment state.

## Message archive worker upgrades

Follow the [archive upgrade notes](../upgrading.md#message-archive-worker-and-tools)
and [ownership/recovery procedure](../message-archive.md#capacity-and-recovery).
Code deployment does not authorize applying a production repair manifest.

Configure the guild debug channel and register `/archive` after adding `archive` to msg-archive's local
`commands` list: `npm run register -- -t msg-archive`. See
[archive control setup](../message-archive.md#discord-controls); existing installations
without saved schedule settings start with periodic scans disabled.
