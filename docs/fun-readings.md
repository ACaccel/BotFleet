# Daily fun readings

`/gay user:<member>` returns an entertainment score; adding a different `user2`
returns a pair's CP score. Selecting the same member twice uses the single mode.
Readings do not infer sexuality or relationships. Dates follow the bot's
[`timeZone`](configuration.md#common-bot-settings).

## Calculation

The base generator hashes the subject IDs and local date with SHA-256 and reads
the first unsigned 32-bit integer. A second hash uses a `#2` seed suffix.

| Mode   | Rule                                                                                                                                                                                                                        |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single | When the first integer is divisible by 20, use the second modulo 30 (0–29). Otherwise use 30 plus the second modulo 71 (30–100). The branches occur approximately 5% and 95% of the time.                                   |
| Pair   | Hash the two IDs in the given order (`user` then `user2`) with the date, and take modulo 101 (0–100). Add the optional interaction bonus and cap at 100. `A x B` and `B x A` are separate pairings with independent scores. |

Single archive traits append active-day count and, when known, the rounded
percentage of messages containing emoji to the seed. Message volume does not
award points. Emoji includes Unicode emoji presentation, variation-selector
sequences, keycaps and Discord custom emoji; plain digits and text symbols do not
count. A message counts at most once toward the emoji proportion.

Pair bonuses use distinct local dates, not raw message counts:

| Element                 | Points                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------- |
| Mutual replies          | `min(10, 2 × min(A→B days, B→A days) + min(2, max(A→B days, B→A days)))`               |
| Mutual direct @mentions | The same calculation, capped at 5                                                      |
| Shared activity         | One point per date on which both posted in at least one identical channel, capped at 5 |

A reply also mentioning its recipient contributes only to replies. Unknown
reply or mention fields omit that element; both directions must be known to
award its bonus. The total bonus is at most 20. Reaction membership, stickers,
message meaning and private conversations are not calculation inputs.

Comments use tiers 0–39, 40–74 and 75–100, with two catalog lines per tier. The
ten-block meter rounds `percent / 10` to the nearest whole block.

## Optional archive and daily stability

Only the last 30 complete local dates are counted; today's messages are excluded.
The reader selects the requested members' human messages of types 0 and 19,
excluding webhooks and known deleted messages. Each read applies the
[public data-command permission rules](architecture.md#privacy-aware-data-commands)
before querying. Missing member permissions or channel metadata failures skip
archive calculations; private threads never contribute to a public reading.

Archive metadata and summary reads each have a 500 ms server and client budget.
Summary queries use the existing channel/time index; an absent index allows a
retry only within the remaining budget. There is no archive scan or Discord
history fetch outside this budget. No archive, no member messages, unknown
content, or a failed query omits the affected input without a penalty. If any
counted message's content is unknown, that member's emoji proportion is omitted.
Incomplete backups describe only observed activity, not the full history.

The first reading is atomically stored in the separate `gay_readings` collection,
including a base reading after an archive timeout or missing data. It contains
only a hashed identity, score, comment key and expiry time. Identity includes
the calculation version, local date, time zone, ordered subject IDs and currently
permitted channel set; the guild database supplies guild isolation. Permissions
are resolved before accessing a snapshot. Equivalent scopes share a reading
across bots and restarts; different scopes can produce different scores.
Archive backfills affect a previously stored scope on the next date. Changing
permissions or the calculation version starts a different snapshot.

Snapshot reads and writes each have a 500 ms server/client budget. If storage
fails, the command returns its deterministic base reading rather than a volatile
archive-derived result; a later successful storage attempt may establish a
different reading. A TTL index removes snapshots after three days, asynchronously.
Bots write these scores only; msg-archive remains the sole archive writer.

No new configuration or command registration is required for this behavior.

## Performance check

An isolated local MongoDB check used 50,000 synthetic messages across 100 authors
and 100 channels, a 30-day window, and the existing channel/time index. Six runs
with 20 permitted channels (200 matching member messages) took 14.0–42.6 ms;
six with all 100 channels (1,000 matching messages) took 63.3–70.4 ms. All twelve
completed within the 500 ms summary budget. Insertion had warmed the data cache;
these measurements exclude permission resolution and snapshot storage and do
not predict disk-cold or production latency.
