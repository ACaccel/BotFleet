# `msg_backup` — Full Discord history re-ingest

Ops tool that walks every accessible channel of one or more guilds
from `start_date` forward (or from the very beginning if
`start_date` is empty) and **unconditionally upserts** every fetched
Discord message into Mongo. Bot-authored messages are deleted from
the DB, and a pre-pass purges any historical dirty rows that fail
basic validity checks.

The runtime backup plugin (`src/plugins/message-backup/`) handles
the steady-state incremental ingest. This tool is the **one-shot
re-alignment hammer** — use it when the DB has drifted from
Discord-side truth (legacy `messageId: null` rows, stale reaction
counts, missing attachment metadata, etc.).

## When to use it

Run `msg_backup` when a guild's `messages` collection has drifted from
Discord-side truth and needs a one-shot reconciliation — typically
signalled by `npm run db -- verify` reporting non-zero violations for
`messageId-null`, `messageId-empty-string`, or `messageId-duplicate`, or
by a report that DB-side reaction counts / edited content no longer
match Discord.

**Do not** schedule it as a nightly job: it is a recovery hammer, not a
maintenance task, and it must not run alongside the runtime
`message-backup` plugin — both write the same collection, and a
concurrent incremental pass will fight the full re-ingest.

## Layout

```
tools/msg_backup/
├── msg_backup.ts
├── config.example.json   # tracked — copy to config.json and edit
├── config.json           # gitignored — operator supplies credentials
├── logs/                 # gitignored — per-run output
│   └── msg_backup_<YYYY-MM-DD_HH-MM-SS>.log  # pure-text, one file per run
└── README.md
```

## Configuration

Copy `config.example.json` to `config.json` and fill in:

| Field                 | Type          | Required | Default | Notes                                                                                                                                                                                                                              |
| --------------------- | ------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mongo_uri`           | `string`      | yes      | —       | Base URI. The tool strips any query string and re-asserts a single trailing slash before `MongoConnectionManager` appends the DB name + `?authSource=admin`. Either `mongodb://host/` or `mongodb://host/?authSource=admin` works. |
| `discord_token`       | `string`      | yes      | —       | Bot token. **Do not commit `config.json`.**                                                                                                                                                                                        |
| `start_date`          | `string`      | no       | `""`    | Local-time `YYYY-MM-DD`. Empty (or omitted) means "no lower bound — backfill every message the channel has".                                                                                                                       |
| `guilds`              | `string[]`    | yes      | —       | Non-empty array of Discord snowflake guild ids. Empty array is rejected — there is no "all guilds in cache" fallback.                                                                                                              |
| `delete_bot_messages` | `boolean`     | no       | `true`  | When `true`, bot-authored messages are deleted from the DB. Set `false` to keep them.                                                                                                                                              |
| `batch_size`          | `integer > 0` | no       | `500`   | Number of fetched messages buffered before each Mongo `bulkWrite`. Raised from 100 → 500 in the unconditional-upsert rework: bulkWrite throughput peaks well above 100 and 500 keeps crash loss bounded to one batch.              |

There are **no CLI arguments**.

## Running

```
npm run msg_backup
```

The tool logs in as the configured bot, waits for the gateway
`ready` event, opens one Mongo connection per target guild via the
project's `MongoConnectionManager`, walks each channel newest-to-
oldest, and prints a per-guild summary followed by an overall
overview. Process exit code is `0` iff every guild's cleanup pass
succeeded.

### Server timezone

`monthKey` aggregation uses the **server's local timezone**. The
run-log header records the offset (e.g. `Server timezone: UTC+8`)
so it is auditable after the fact. Re-running on a host in a
different timezone will bucket the same message into a different
month — keep the operator host's timezone stable across runs to
keep monthly breakdowns comparable.

### Estimated runtime

Discord's message-fetch rate limit caps throughput at ~50 msg/sec.
A guild with ~5M messages takes roughly 15–20 hours of fetching,
plus Mongo upsert overhead. Run it under `tmux` or `screen` and
monitor `stdout`.

## Behaviour

### What the tool does

For each guild:

1. **Cleanup pass** (runs BEFORE channel discovery). Each of the
   seven checks runs in its own `try`/`catch` — a single failed
   check does NOT abort the others. The guild itself is only marked
   `failed` when **every** check errored. Failing checks are
   surfaced in the summary as `ERROR (<reason>)`. The checks:
   - `messageId` null/empty → `deleteMany`
   - `messageId` duplicates → keep first row of each group, delete the rest
   - `channelId` null/empty → `deleteMany`
   - `userId` null/empty → `deleteMany`
   - `userName` null/empty → `deleteMany`
   - `timestamp` non-numeric / `<= 0` → `deleteMany`
   - total messages remaining → `countDocuments` (stat only)

   Per-check progress is emitted to both stdout and the run-log:
   `[Cleanup] Checking <name>...` followed by
   `[Cleanup] <name>: deleted N (elapsed Xs)`.

2. **Channel discovery**. Enumerate text-like guild channels plus
   active threads plus archived threads. The archived-thread list is
   **paginated** until the page returns fewer than the limit — large
   forums no longer silently lose history past the first 50 threads.
   `guild.channels.fetch()` is capped at 60s by `Promise.race`; on
   timeout the guild fails with an explicit reason.

3. **Per-channel backfill** (newest-to-oldest, pages of 100). For
   each fetched message:
   - `msg.author === null` (deleted webhook / removed cross-post
     source) → counted as `skipped-null-author`, NOT upserted.
   - Bot-authored → queued for deletion if `delete_bot_messages` is
     `true`.
   - Otherwise → queued for a `bulkWrite` `updateOne` with
     `filter: {messageId}`, `update: {$set: <full doc>}`, `upsert: true`.
     **The DB row is overwritten in full every run** — reaction
     counts, content edits, and attachment metadata always re-align
     with Discord-side truth.

4. **Fetch cursor**. After the channel finishes, `Fetch.lastMessageID`
   is upserted to the newest message id seen — or to `''` for a
   channel that had zero messages, so msg-archive's incremental path
   has a row to read against either way. The cursor write is wrapped
   in `try`/`catch`; a failure here marks the channel
   `cursor-persist-failed` (the backfill data itself succeeded), not
   `aborted`.

### Channel outcome statuses

| Status                  | Meaning                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `ok`                    | Channel completed without retries or persistence issues.                                   |
| `retried-but-ok`        | Channel finished, but at least one transient `messages.fetch` retry fired.                 |
| `aborted`               | Mid-channel exception bubbled out of `withRetry`.                                          |
| `no-permission`         | DiscordAPIError 50001 / 50013 — bot lacks View Channel / Read Message History.             |
| `channel-not-found`     | DiscordAPIError 10003 / 10004 — channel or guild went away mid-run.                        |
| `guild-not-accessible`  | `guild.fetch()` itself failed; the whole guild yields a single channel-like row.           |
| `cursor-persist-failed` | Backfill succeeded but the `Fetch` upsert threw; msg-archive resumes from the old cursor.  |
| `thread-enum-failed`    | Parent-channel thread enumeration failed; the threads underneath were not backfilled.      |
| `field-skip-ok`         | Channel completed `ok` but at least one message triggered the field-skip rule (see below). |

### Anomaly list

Each per-guild summary ends with an `Anomaly list:` section. Every
channel whose status is not `ok` is listed — plus any channel whose
status is `ok` but observed a retry (`retried-but-ok`). Operators
can sweep this section to see exactly which channels need attention
without diffing the verbose per-channel logs.

### Retry on transient Discord errors

Every `messages.fetch` call is wrapped in a small retry helper that
backs off `1s → 2s → 4s` (three attempts). The transient predicate
uses explicit allow/deny lists:

- Allow-retry: HTTP `429 / 500 / 502 / 503 / 504`, node-level
  `ECONNRESET` / `ETIMEDOUT` / `EAI_AGAIN` / etc.
- Bypass-retry-entirely (non-transient): DiscordAPIError codes
  `10003 / 10004 / 10008 / 50001 / 50013 / 50021 / 50035`.

After the third retry the channel is marked `aborted`. Hard
non-transient codes never enter the retry loop — they classify
straight into `no-permission` or `channel-not-found`.

### Per-guild error isolation

Each guild runs inside its own `try` / `catch`. A failure on one
guild logs and the tool continues with the next guild. The final
overview lists every guild's status (`ok` or `failed`).

## Logging

Two sinks side by side:

| Sink                                        | Format      | Purpose                                         |
| ------------------------------------------- | ----------- | ----------------------------------------------- |
| Pretty stdout                               | pino-pretty | Live monitoring while the tool runs.            |
| `logs/msg_backup_<YYYY-MM-DD_HH-MM-SS>.log` | pure text   | One human-readable file per run; never rotated. |

The text log is the operator-facing record. Layout: boxed config
header (includes `Server timezone`), per-guild cleanup block with
per-check progress lines, channel discovery list with per-batch
thread pagination progress, per-channel progress (one line per
month boundary), per-guild summary with the `Anomaly list`, an
`OVERALL SUMMARY` with a "sorted by upserted desc" per-channel
breakdown, and an `End of run (status: COMPLETED|FAILED)` footer.
The `mongo_uri` password is masked as `****` in the header.

Run-log writes are wrapped in `try`/`catch`. If the file becomes
unwritable mid-run (disk full, fs error), the tool falls back to
mirroring all subsequent output to stderr and prints a final
warning so the operator knows the file is incomplete.

There is **no** JSON Lines output, no daily rotation, and no
separate `error.log` — a fatal error appears inline in the same
file with the `FAILED` status in the footer.

## Safety notes

- `config.json` is `.gitignore`d — credentials never leave the
  operator's machine.
- The tool destroys the Discord client and closes every Mongo
  connection in a `finally`, even on fatal errors.
- After the tool finishes, restart the affected bot. On startup
  the bot's `Model.init()` should build the `messages.messageId_1`
  unique index cleanly (the symptom this tool is designed to fix).
  Re-run `npm run db -- verify` to confirm.

## Field-skip behaviour

The three nested arrays — `attachments`, `reactions`, `stickers` —
are subject to a strict "preserve the DB-side value" guarantee.
When Discord returns a message whose attachment / reaction /
sticker element carries a critical `null` field (typically
`attachment.name === null` on a deleted-webhook message, or
`sticker.name === null` from a removed third-party pack),
`buildBackfillDoc` **omits the entire corresponding array from the
`$set` payload**.

Why omit the whole array (not just the bad element):

- Mongo `$set` cannot do a partial-array merge; writing a filtered
  subset would still overwrite the DB array in full and lose any
  elements the DB had that Discord did not return this time.
- These edge messages are very rare; preserving the DB's prior
  (likely-also-edge) state is safer than substituting `''`
  placeholders.

Per-channel, per-month, per-guild, and overall summaries include
dedicated counters that surface every preservation event:

- `skipped-attachments` — messages where `attachments` was omitted.
- `skipped-reactions` — messages where `reactions` was omitted.
- `skipped-stickers` — messages where `stickers` was omitted.

Channels that triggered any field-skip but otherwise completed
successfully are listed in the Anomaly block as `field-skip-ok`.
A channel that also tripped the transport retry loop is listed as
`retried-but-ok` instead — transport flakiness has higher
precedence because operators care more about link quality than
per-message edge cases.

## Tests

The pure internals (`parseConfig`, `buildBackfillDoc`,
`isTransientError`, `withRetry`, `buildAnomalies`, …) live in
`tools/msg_backup/internal.ts` and are covered by a dedicated unit
suite under `tools/msg_backup/msg_backup.test.ts`:

```
npm run msg_backup:test
```

The suite runs in the `tools` vitest project and exercises the
retry / field-skip / anomaly logic without booting Discord or Mongo.
