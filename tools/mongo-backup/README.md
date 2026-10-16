# Daily MongoDB backup

A systemd timer dumps every application database once a day while the bots keep
running. Use the [migration runbook](../migration/README.md) instead for host
transfer: it stops writers, includes ignored runtime files and recreates users.

## Behavior

- Runs daily at 03:30 (plus up to 15 minutes random delay); `Persistent=true` catches
  up a run missed while the host was off.
- Lists every database except `admin`, `config` and `local`, then runs `mongodump --gzip`
  per database with the `MONGO_URI` of `mongodb.probeEnvFile` in `deployment.json`. The
  URI is passed through a temporary `0600` config file, never the command line.
- Writes `<dir>/mongodb-<UTC timestamp>/` (`0700`) containing `<database>/` dumps and
  `manifest.json` (databases and collections). A snapshot appears only after every listed
  collection has a dump file; failures leave earlier snapshots untouched.
- Keeps the newest 3 snapshots and deletes older ones after a successful run.
- Each collection is read at a slightly different time, so documents written during the
  run may be missing; collections are not a single point-in-time snapshot. MongoDB users
  and roles in `admin` are not included.

Defaults: `--dir /var/backups/pleiades`, `--keep 3`. The directory must be an absolute
path of letters, digits, `.`, `_`, `-` and `/`. One snapshot of the 2026-10 production
data was about 390 MB and took about 70 seconds.

## Install

Run as the `deployment.json` user after the MongoDB service is deployed; system changes
prompt for sudo. Re-run to change options.

```bash
npm run backup:install                      # or: -- --dir /path --keep 7
sudo systemctl start pleiades-mongo-backup.service   # first snapshot now
```

Review the units without installing them:
`node scripts/runtime.mjs exec node tools/mongo-backup/install.mjs render /absolute/output`.

`npm run backup:uninstall` removes the units and keeps existing snapshots.

## Check

```bash
systemctl list-timers pleiades-mongo-backup.timer
journalctl -u pleiades-mongo-backup.service -n 20
ls /var/backups/pleiades
```

## Restore

1. Stop the bots that write the affected databases (`sudo systemctl stop pleiades@<bot>`).
2. Write a private credentials file, for example
   `install -m 600 /dev/null /tmp/restore.yml`, then add the line `uri: "<MONGO_URI>"`.
3. Restore one database, replacing its current collections:

   ```bash
   <mongodb.prefix>/bin/mongorestore --config /tmp/restore.yml --gzip --drop \
     --nsInclude '<database>.*' --dir /var/backups/pleiades/mongodb-<timestamp>
   ```

   Omit `--nsInclude` to restore every database in the snapshot.

4. Delete `/tmp/restore.yml` and start the bots again.
