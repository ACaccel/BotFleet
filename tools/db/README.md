# `db` — unified DB-maintenance ops CLI

A CLI for retired-feature collection cleanup, sharing connection, configuration
and logging through one `config.json`. Message archive maintenance is managed
through [Discord archive commands](../../docs/message-archive.md#discord-controls).
Whole-database host transfer remains in the [migration runbook](../migration/README.md).

```bash
npm run db -- drop-todo           # drop the retired todo_list `todos` collection
npm run db -- drop-xfeed          # drop the retired x-media-feed `xfeedcursors` collection
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
| `guilds`      | `string[]`       | yes      | All-digit guild IDs; both subcommands accept multiple guilds.                                                    |
| `output_path` | `string \| null` | no       | When set, the JSON report is written here instead of stdout. Default`null`.                                      |

### Per-operation options (`operations.<name>`)

| Operation    | Field     | Type      | Default | Meaning                                        |
| ------------ | --------- | --------- | ------- | ---------------------------------------------- |
| `drop-todo`  | `dry_run` | `boolean` | `true`  | `true` counts only; `false` performs the drop. |
| `drop-xfeed` | `dry_run` | `boolean` | `true`  | `true` counts only; `false` performs the drop. |

There are **no other CLI arguments** — everything else comes from
`config.json`.

## Output & exit codes

Every command writes a JSON report to stdout (or `output_path`), then a
final summary line. Exit `0` on success, `1` on failure. A single guild's
failure never aborts the rest of the fleet (`drop-todo` / `drop-xfeed`); it is recorded in the report and flips the
exit code.

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

The pure helpers (config loader, per-guild runner, the
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
