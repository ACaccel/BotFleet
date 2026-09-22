# `db` — unified DB-maintenance ops CLI

One CLI for every database-maintenance operation, selected by a
subcommand. It replaces the standalone `verify_db`, `migrate_timestamp`,
and `drop_todo_collection` tools, sharing one connection/config/logging
layer and a single `config.json`.

```bash
npm run db -- verify              # read-only structural validation (one guild)
npm run db -- migrate-timestamp   # migrate Message.timestamp String -> numeric
npm run db -- drop-todo           # drop the retired todo_list `todos` collection
npm run db -- drop-xfeed          # drop the retired x-media-feed `xfeedcursors` collection
```

Optional `--config <path>` overrides the default `tools/db/config.json`.

## Layout

```
tools/db/
├── db.ts                 # entry point — argv parsing, dispatch, exit code
├── registry.ts           # subcommand registry (the extensibility point)
├── framework/            # shared layer (config, connection, runner, report, …)
├── commands/             # one module per operation (verify / migrate-timestamp / drop-todo / drop-xfeed)
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

| Field         | Type             | Required | Notes                                                                                                             |
| ------------- | ---------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `mongo_uri`   | `string`         | yes      | Base cluster URI. The per-guild db name + `authSource=admin` are appended per guild; any query string is dropped. |
| `guilds`      | `string[]`       | yes      | All-digit guild ids. `verify` requires **exactly one**; every other subcommand accepts many.                      |
| `output_path` | `string \| null` | no       | When set, the JSON report is written here instead of stdout. Default `null`.                                      |

### Per-operation options (`operations.<name>`)

| Operation           | Field          | Type           | Default | Meaning                                        |
| ------------------- | -------------- | -------------- | ------- | ---------------------------------------------- |
| `verify`            | `sample_limit` | `integer >= 0` | `50`    | Max sample docs per check. `0` = count only.   |
| `migrate-timestamp` | `mode`         | enum           | —       | `audit` \| `convert` \| `index`.               |
| `migrate-timestamp` | `dry_run`      | `boolean`      | `false` | `convert` only: count + sample, write nothing. |
| `migrate-timestamp` | `sample_limit` | `integer >= 0` | `20`    | Cap on `_id` samples in reports.               |
| `drop-todo`         | `dry_run`      | `boolean`      | `true`  | `true` counts only; `false` performs the drop. |
| `drop-xfeed`        | `dry_run`      | `boolean`      | `true`  | `true` counts only; `false` performs the drop. |

There are **no other CLI arguments** — everything else comes from
`config.json`.

## Output & exit codes

Every command writes a JSON report to stdout (or `output_path`), then a
final summary line. Exit `0` on success, `1` on failure. A single guild's
failure never aborts the rest of the fleet (`migrate-timestamp` /
`drop-todo` / `drop-xfeed`); it is recorded in the report and flips the
exit code.

## `db verify`

Read-only validation of one guild's `messages` collection against eight
structural checks.

### Why it exists

`message.schema.ts` declares
`messageId: { type: String, required: true, unique: true }`. Documents
written before `required: true` was introduced persist with
`messageId: null` or `''`, and a few collections carry duplicate
`messageId`s left by earlier ingest bugs. In either case the
unique-index build aborts:

```
MongoServerError: E11000 duplicate key error collection: ...
  index: messageId_1 dup key: { messageId: null }
```

and the collection ends up **without** the `messageId_1` index at all —
the schema invariant production code relies on is silently absent, with
no runtime symptom until a downstream report breaks.

`verify` is the standard way to measure how bad that is before running
the `msg_backup` remediation tool, and to confirm afterwards that the
cleanup worked. It also catches related integrity problems (empty
`channelId` / `userId` / `userName`, non-numeric or non-positive
`timestamp`) that would otherwise stay hidden.

Read the report as a workflow: note the `messageId-null`,
`messageId-empty-string`, and `messageId-duplicate` counts, run
[`msg_backup`](../msg_backup/README.md) against the affected guild to
re-ingest history, restart the bot so `Model.init()` builds the unique
index without `E11000`, then re-run `verify` and expect `PASS`.

| Check                    | Detects                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `messageId-null`         | `messageId === null`                                               |
| `messageId-empty-string` | `messageId === ''`                                                 |
| `messageId-duplicate`    | Non-null `messageId` values that appear in more than one document. |
| `channelId-missing`      | `channelId` is `null` or `''`.                                     |
| `userId-missing`         | `userId` is `null` or `''`.                                        |
| `userName-missing`       | `userName` is `null` or `''`.                                      |
| `timestamp-invalid`      | `timestamp` is not a `number`, or is `<= 0`.                       |
| `total-count`            | Informational — total document count. Never a violation.           |

For each filter check the tool collects up to `sample_limit` offending
docs (`_id`, the offending value, `channelId`, `userId`, `timestamp`, and
the first 50 chars of `content`). For `messageId-duplicate` it reports the
offending ids and their counts (`duplicateGroups`); `violationCount` is
the total _extra_ row count. `PASS` (exit 0) when every check is zero,
`FAIL (N violations across all checks)` (exit 1) otherwise.

The tool never writes, updates, or deletes any document.

## `db migrate-timestamp`

Migrates `Message.timestamp` to a uniform numeric type across every guild
so the `MessageRepo` range queries can drop `$toLong` and become
index-served.

### Why it exists

`message.schema.ts` declares `timestamp: { type: Number }`, but the
pre-refactor schema stored it as a **String**, so legacy rows may hold
String values while every current write is numeric. To span both,
`findByTimestampRange` / `findByChannelAndTimestampRange` wrapped each
comparison in `$expr: { $toLong: '$timestamp' }` — a computed predicate
no btree index can serve, forcing a full collection scan on every
`/traffic`, `/traffic_me`, and `db_list_message` read. Making the data
uniformly numeric is what lets that predicate become a plain,
index-served range.

> **Hard gate.** The repo predicate change (drop `$toLong`, add the
> indexes) MUST NOT ship to any guild whose data still has String-typed
> timestamps. Run `audit` → `convert` → re-`audit` and confirm **zero**
> String-typed timestamps fleet-wide before deploying the code change.

### Runbook

1. **Audit** (`mode: "audit"`, read-only). Per guild: total, `string-typed`,
   `numeric-string` (convertible), `non-numeric-string` (garbage → manual
   triage), `null-or-missing`. The final line recommends whether conversion
   is needed. If every guild reports `string-typed == 0`, skip to step 4.
2. **Convert** (`mode: "convert"`, write). For each guild with convertible
   rows the tool, in order:
   1. takes a **mandatory** in-database snapshot
      `messages_backup_pre_ts_<UTC>` and asserts its count equals the
      source (fail-fast — no backup, no convert);
   2. runs the String → numeric `updateMany` (pipeline `$convert`, leaving
      any unconvertible value untouched);
   3. re-counts convertible rows and requires `0`.
   - Preview first with `dry_run: true` (counts + `_id` sample, no writes).
   - `non-numeric-string` rows are **never** auto-converted; they are
     reported for manual triage and keep the deploy gate closed.
   - For the largest / most critical guilds, also take an off-box dump:
     `mongodump --uri <guildUri> --collection messages --out tools/db/backups/<guildId>-<ts>/`.
3. **Verify**: re-run `audit`; confirm `string-typed == 0` fleet-wide.
4. **Index** (`mode: "index"`, write, in a maintenance window). Builds
   `{ timestamp: 1 }` and `{ channelId: 1, timestamp: 1 }` per guild
   (idempotent). Do this before the schema change ships so the next boot's
   `model.init()` finds the indexes present and stays a no-op.
5. **Deploy** the repo predicate change. Re-run `audit` once more first.

### Safety & restore

- **Backup is mandatory and fail-fast**: convert refuses to write a guild
  until its `$out` snapshot exists and its count matches the source.
- **Value-preserving and monotonic**: only the BSON type changes
  (String → Long); the numeric value, sort order, and counts are unchanged.
- **Idempotent**: re-runs match nothing already numeric.
- **Restore** (same-db snapshot): `db.messages.drop()` then
  `db.messages_backup_pre_ts_<ts>.aggregate([{ $out: 'messages' }])`.
- **Restore** (mongodump): `mongorestore --uri <guildUri> --drop --nsInclude '<db>.messages' tools/db/backups/<guildId>-<ts>/`.
- **Cleanup**: once verified and stable, drop the `messages_backup_pre_ts_*`
  collections / dumps.

### Exit codes

- `audit` — always `0`. Recommendation is on the final line.
- `convert` — `0` when every guild is converted and verified clean (or
  dry-run); `1` if any guild errored or is left String-typed.
- `index` — `0` when indexes are ensured on every guild; `1` on any error.

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

## Tests

```bash
npm run db:test
```

The pure helpers (config loader, per-guild runner, progress writer, the
per-command builders and contracts) live next to their modules and are
covered without a live Mongo connection. The process entry point is
exercised only through manual ops runs.

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
