# `db` — unified DB-maintenance ops CLI

A CLI for retired-feature collection cleanup and the one-time legacy message-archive
rebuild, sharing connection, configuration and logging through one `config.json`.
Day-to-day message archive maintenance is managed through
[Discord archive commands](../../docs/message-archive.md#discord-controls).
Whole-database host transfer remains in the [migration runbook](../migration/README.md).

```bash
npm run db -- drop-todo           # drop the retired todo_list `todos` collection
npm run db -- drop-xfeed          # drop the retired x-media-feed `xfeedcursors` collection
npm run db -- archive-legacy-isolate  # move the legacy message archive aside
npm run db -- archive-legacy-export   # export legacy messages missing from the new backup
npm run db -- archive-legacy-drop     # drop the isolated legacy archive after its export
```

Optional `--config <path>` overrides the default `tools/db/config.json`.
The retired message-only operations are no longer registered. Existing local
credentials and reports are preserved; obsolete operation sections can be removed
from your local configuration when they are no longer needed.

## Layout

```
tools/db/
├── db.ts                 # entry point — argv parsing, dispatch, exit code
├── registry.ts           # subcommand registry (the extensibility point)
├── framework/            # shared layer (config, connection, runner, report, …)
├── commands/             # one module per operation (drop-todo / drop-xfeed)
│   └── archive-legacy/   # isolate / export / drop and their shared helpers
├── backups/              # gitignored — default home of export archives
├── config.example.json   # tracked — copy to config.json and edit
├── config.json           # gitignored — operator supplies credentials
└── README.md
```

## Configuration

Copy `config.example.json` to `config.json` and fill it in. The config
has a shared connection block plus an `operations` map keyed by
subcommand name; only the active subcommand's section is read on a run.
`config.json` is gitignored — never commit operator credentials.

### Shared block

| Field         | Type             | Required | Notes                                                                                                            |
| ------------- | ---------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `mongo_uri`   | `string`         | yes      | Base cluster URI. The per-guild db name +`authSource=admin` are appended per guild; any query string is dropped. |
| `guilds`      | `string[]`       | yes      | All-digit guild IDs; every subcommand accepts multiple guilds.                                                   |
| `output_path` | `string \| null` | no       | When set, the JSON report is written here instead of stdout. Default`null`.                                      |

### Per-operation options (`operations.<name>`)

| Operation    | Field     | Type      | Default | Meaning                                        |
| ------------ | --------- | --------- | ------- | ---------------------------------------------- |
| `drop-todo`  | `dry_run` | `boolean` | `true`  | `true` counts only; `false` performs the drop. |
| `drop-xfeed` | `dry_run` | `boolean` | `true`  | `true` counts only; `false` performs the drop. |

The `archive-legacy-*` options are listed with each command under
[Legacy message-archive rebuild](#legacy-message-archive-rebuild).

There are **no other CLI arguments** — everything else comes from
`config.json`.

## Output & exit codes

Every command writes a JSON report to stdout (or `output_path`), then a
final summary line. Exit `0` on success, `1` on failure. A single guild's
failure or refusal never aborts the rest of the fleet; it is recorded in the
report and flips the exit code.

## `db drop-todo`

Permanently drops the retired `todo_list` feature's `todos` collection
(one per guild database). **Dry-run by default** (`dry_run: true`): counts
only, writes nothing. Set `dry_run: false` to perform the drop. Re-runs
are idempotent — a guild whose collection is already gone is reported
`absent`.

Per-guild `status`: `would-drop` (dry run), `dropped`, `absent`, or
`error`. Exit `0` when no guild errored, `1` otherwise.

```bash
# 1. Audit — confirm the per-guild counts (dry_run: true, the default).
npm run db -- drop-todo
# 2. Drop — set operations.drop-todo.dry_run = false, then re-run.
npm run db -- drop-todo
# 3. (optional) Re-run to confirm every guild now reports "absent".
npm run db -- drop-todo
```

## `db drop-xfeed`

Permanently drops the retired X-media-feed `xfeedcursors` collection
(one per guild database), left behind when subscriptions and their
cursors moved into one `feedsubscriptions` document. Nothing is
migrated: the old cursors were keyed by handle alone, and re-subscribing
with `/feed_subscribe` seeds a fresh cursor from the present.
**Dry-run by default** (`dry_run: true`): counts only, writes nothing.
Set `dry_run: false` to perform the drop. Re-runs are idempotent — a
guild whose collection is already gone is reported `absent`.

Per-guild `status`: `would-drop` (dry run), `dropped`, `absent`, or
`error`. Exit `0` when no guild errored, `1` otherwise.

```bash
# 1. Audit — confirm the per-guild counts (dry_run: true, the default).
npm run db -- drop-xfeed
# 2. Drop — set operations.drop-xfeed.dry_run = false, then re-run.
npm run db -- drop-xfeed
# 3. (optional) Re-run to confirm every guild now reports "absent".
npm run db -- drop-xfeed
```

## Legacy message-archive rebuild

Three commands retire the legacy message archive instead of migrating it:
isolate the legacy collections, let msg-archive run a full backup with the new
schema (`/archive backup`), export what that backup cannot reproduce, then drop
the legacy data. Every command is **dry-run by default** and refuses a guild
whose precondition fails (`status: "refused"`, exit `1`) without changing it.
Take a `mongodump` of every guild database before the first real run.

Export and drop need the Info-ZIP `zip` and `unzip` binaries, which
[`environment.yml`](../../environment.yml) installs into the project runtime
(`bash scripts/setup-env.sh`). Both commands stop before connecting when either
binary is missing or `output_dir` is unacceptable: it must not contain `*`, `?`
or `[`, and may be inside the repository only under `tools/db/backups/`. The
binaries run with an argument array, closed stdin, a six-hour timeout, and the
`ZIP` / `ZIPOPT` / `UNZIP` / `UNZIPOPT` variables removed. When `output_path` is
set, the JSON report is written with mode `0600` because it names channels.

### `db archive-legacy-isolate`

Requires msg-archive to be stopped. A real run claims msg-archive's owner lease
in `archive_leases` atomically (the same `_id: "owner"` document, with a
`host:pid:uuid` owner ID) for the duration of the run, so msg-archive cannot
start meanwhile, and releases it afterwards; a dry run only checks that no lease
is held. A crashed process leaves its lease behind; delete it only after
confirming the process is gone. Also refuses when `messages` already holds
new-format (`schemaVersion: 3`) documents, or when another `legacy_*` set exists.

| Collections                                                                                                                                                                                                                                                                                                                            | Action                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `messages`, `archive_revisions`, `archive_reactions`, `archive_quarantine`, `archive_channels`, `fetches`, `archive_inbox`                                                                                                                                                                                                             | renamed to `legacy_<timestamp>_<name>` (instant) |
| `archive_repair_*`, `archive_control_*`, `archive_bulk_*`, `archive_journals`, `archive_jobs`, `archive_periodic_runs`, `archive_progress_details`, `archive_plan_deletions`, `archive_gc_checkpoints`, `archive_gateway_continuity`, `archive_control_confirmations` (start approvals), `archive_storage_usage` (host storage sample) | dropped, not exported                            |
| `archive_schedule`                                                                                                                                                                                                                                                                                                                     | kept, forced to disabled                         |
| `archive_leases`                                                                                                                                                                                                                                                                                                                       | kept                                             |
| any other `archive_*`                                                                                                                                                                                                                                                                                                                  | reported as `keep-unclassified`, never touched   |

Steps run in this order: disable the schedule, rename (`messages` last), drop.
If a step fails, the guild reports `partial` with a `done` flag per collection
and `resumeWith.legacy_timestamp`; set that option and re-run to finish. The dry
run reports each collection's document count, size, storage size and action. One
`legacy_timestamp` (milliseconds) is used for every guild in a run and printed in
the report and summary line; the next two commands need it.

| Field              | Type             | Default | Meaning                                                                      |
| ------------------ | ---------------- | ------- | ---------------------------------------------------------------------------- |
| `dry_run`          | `boolean`        | `true`  | `true` reports only.                                                         |
| `legacy_timestamp` | `string \| null` | `null`  | Resume an interrupted isolation into this existing set instead of a new one. |

### `db archive-legacy-export`

Requires a `complete` `full-backup` job in the guild's new `archive_jobs` whose
`finishedAt` is later than `legacy_timestamp` (known coverage gaps still finish
`complete`), unless `force: true`. Also refuses when the legacy set holds a
collection isolation never creates. Exports:

- legacy `messages` and `archive_quarantine` documents — duplicates included —
  whose `messageId` is not held with content by the new `messages` (`_id`). A
  new document with none of `author`, `content`, `attachments`, `embeds`,
  `stickers`, `components`, `poll`, `messageSnapshots` or `interactionMetadata`
  is a bare tombstone (a deletion of a message msg-archive never observed) and
  does not count;
- those messages' legacy `archive_revisions` and `archive_reactions` records;
- every legacy `archive_inbox` event not in state `complete` (events the legacy
  writer never applied), in `inbox/pending.json`.

Messages and their related records are classified by the channel's `access` in
the new `archive_channels`:

| Category               | Channel state in the new backup                                                   |
| ---------------------- | --------------------------------------------------------------------------------- |
| `channel-deleted`      | `deleted`                                                                         |
| `channel-inaccessible` | `denied`, `unknown`, or no record                                                 |
| `message-missing`      | `readable` — the message was deleted (including tombstones) or excluded by policy |
| `unattributed`         | the legacy document has no valid message or channel ID (e.g. cursor evidence)     |
| `inbox-pending`        | unprocessed inbox events                                                          |

The archive `archive-legacy-<guild>-<timestamp>.zip` holds `manifest.json` and
one file per channel at `<category>/<channelId>.json`, plus `unattributed.json`
and `inbox/pending.json`. Each file is a canonical-EJSON array of
`{ collection, messageId, document }` records, one per line, so every BSON type
(`ObjectId`, dates, `Int32` / `Int64` / `Double`) survives. Channel names come
from the legacy documents. The manifest records the guild, legacy timestamp, the
full-backup job and its cutoff, per-category counts, every file's record counts,
size and sha256, and every `legacy_<timestamp>_*` collection with its exact
`countDocuments` and handling: `compared-against-new-backup` (messages,
quarantine, revisions, reactions — what the new backup holds is intentionally not
kept), `exported` (inbox) or `dropped-by-policy` (`archive_channels`, `fetches`,
which the new backup rebuilds).

Legacy collections are read in `_id` order and in batches of `batch_size`; memory
holds one batch. Related records are exported once per message ID within a batch,
and quarantine skips message IDs that legacy `messages` already covered; a message
ID duplicated across batches of one source exports its related records again.

Files are staged in a private directory inside `output_dir`, packed with
`zip -r`, then verified from the archive alone without extracting it: `unzip -t`,
known entry names only, a manifest schema check, the exact file set, and per-file
streaming (`unzip -p`) of framing, record parsing, counts, size and sha256. The
packed manifest must also equal the staged one. Only a verified archive is
published (mode `0600`) and the staging directory removed; a failure to remove it
afterwards is a warning, not an error. On `verification-failed` or an error the
staging directory is kept and named in the report; leftover staging directories
are listed in `staleStagingDirs` on the next run. An existing archive is never
overwritten. The archive holds private channel content and is not encrypted:
keep it out of version control and external services.

| Field              | Type             | Default | Meaning                                                                |
| ------------------ | ---------------- | ------- | ---------------------------------------------------------------------- |
| `dry_run`          | `boolean`        | `true`  | `true` counts per category and writes nothing.                         |
| `legacy_timestamp` | `string`         | —       | Required. The set reported by `archive-legacy-isolate`.                |
| `force`            | `boolean`        | `false` | Export without a completed full backup (classification is unreliable). |
| `output_dir`       | `string \| null` | `null`  | Archive directory; `null` is `tools/db/backups/`.                      |
| `batch_size`       | `number`         | `1000`  | Documents per `$in` lookup (1–10000).                                  |

### `db archive-legacy-drop`

Re-verifies `archive-legacy-<guild>-<timestamp>.zip` in `output_dir` and requires
its manifest to name the same guild and legacy timestamp, and to list every
remaining `legacy_<timestamp>_*` collection with an unchanged exact document
count; otherwise refuses. Then drops every `legacy_<timestamp>_*` collection. The
dry run also verifies the archive and lists each collection with its document
count. A re-run after the drop reports `absent`.

| Field              | Type             | Default | Meaning                                                     |
| ------------------ | ---------------- | ------- | ----------------------------------------------------------- |
| `dry_run`          | `boolean`        | `true`  | `true` verifies and lists only.                             |
| `legacy_timestamp` | `string`         | —       | Required. The set to drop.                                  |
| `output_dir`       | `string \| null` | `null`  | Where the export archive is; `null` is `tools/db/backups/`. |

## Tests

```bash
npm run db:test
```

The pure helpers (config loader, per-guild runner, the
per-command builders and contracts) live next to their modules and are
covered without a live Mongo connection. The `archive-legacy-*` suites start
their own in-memory MongoDB and use the real `zip` / `unzip` binaries;
`rebuild.test.ts` runs isolate, a simulated rebuild, export and drop end to end. The
process entry point is exercised only through manual ops runs.

## Extending

Adding a new operation is three edits:

1. Write `commands/<name>.ts` exporting a command via `defineCommand`
   (declare its `name`, `description`, a zod `optionsSchema`, and a `run`).
2. Register it in `registry.ts` (`COMMANDS` array).
3. Add its `operations.<name>` section to `config.example.json` and
   document it above.

`run` receives the validated shared config, its own validated options, a
logger, and `withGuildConnection`; it returns a report + summary line +
exit code and never touches `process`.

## Safety notes (all commands)

- `LOG_DIR=''` is forced at startup so the structured logger never
  allocates `logs/<bot>/...` file descriptors.
- Connections are closed on every exit path (success or failure).
- `config.json` is gitignored — never commit operator credentials.
