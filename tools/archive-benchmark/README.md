# Archive performance benchmarks

Developer probes for the archive worker end to end, the history pipeline, REST
admission, CPU normalization, repository persistence, capacity sampling, progress
publication and statistics queries. They use synthetic
data and disposable resources only; they accept no database URI, Discord token,
operator configuration or production input.

The repair-service benchmark (`run.ts`) and the durable enrichment batching
comparison (`enrichment.ts`) measured the one-shot repair workflow, which is
retired; their recorded results remain in the
[performance report](../../docs/contributing/archive-performance-results.md) as
history. Operator-facing workflows are documented in
[`docs/message-archive.md`](../../docs/message-archive.md).

## Pipeline, CPU and publication probes

Run these serially on the same host and use a new report filename each time:

```bash
node scripts/runtime.mjs exec ts-node tools/archive-benchmark/pipeline.ts /tmp/archive-pipeline.json
node scripts/runtime.mjs exec ts-node tools/archive-benchmark/rest.ts /tmp/archive-rest.json
node scripts/runtime.mjs exec ts-node tools/archive-benchmark/cpu.ts /tmp/archive-cpu.json
node scripts/runtime.mjs exec ts-node tools/archive-benchmark/cpu-persistence.ts /tmp/archive-cpu-db.json
node scripts/runtime.mjs exec ts-node tools/archive-benchmark/notifications.ts /tmp/archive-notifications.json
```

The pipeline probe reuses the history test transport and actual history executor,
compares prefetch off/on at concurrency 2/4/8, and verifies identical committed
IDs and drained byte reservations. Its optional shared mock quota is 200 requests/s;
it does not predict Discord's route-specific limits. The REST probe separately
checks per-resource exclusion, guild fairness and reserved live admission during
announced waits. Neither probe sends HTTP requests or manufactures actual 429s.

The CPU probes compare pools 0/1/2/4 with versioned BSON input, bounded 4 MiB
batches, complete snapshot replies and equal output hashes. Startup is reported
separately. The persistence probe includes the real standalone archive repository
with majority/journaled writes and archive schema indexes created before timing.
The report records the installed indexes. These workers are experiments, not enabled product
workers, and receive no credentials or database handles.

The notification probe keeps normalization and snapshot collection identical,
alternates enabled/disabled delivery, excludes a warmup pair and reports three-run
medians. It uses the actual notifier and full-backup panel renderer with a 5-second logical cadence,
isolated majority/journaled progress writes and mock payload encoding; remote
Discord latency is outside its claim. In-flight publication,
retry, coalescing and terminal drain behavior are tested independently.

Results and adoption decisions are recorded in the
[performance report](../../docs/contributing/archive-performance-results.md).

## Worker, re-observation and storage probes

`worker.ts` runs the real `ArchiveWorker`, repository and a disposable MongoDB 8.2.6
(majority/journaled writes, 0.25 GiB cache) against a synthetic guild of voice
channels served by `discord-fake.ts`. The fake REST owner mirrors `@discordjs/rest`:
requests of one route and channel run one after another, each taking `--latency`
milliseconds, while different routes and channels run in parallel. It sends no HTTP.
The probe chdirs into an empty temporary directory so the storage monitor's walk
stays out of the measurement.

```bash
node scripts/runtime.mjs exec ts-node --transpile-only tools/archive-benchmark/worker.ts /tmp/archive-worker.json
node scripts/runtime.mjs exec ts-node --transpile-only tools/archive-benchmark/worker.ts /tmp/archive-segments.json --scenario segments --concurrency 4
```

Scenarios (`--scenario`, comma-separated): `full` confirms and runs a full backup of
an empty archive; `periodic` runs the next periodic pass, whose overlap window
(`overlap_minutes: 1440`) revisits every message; `live` decodes MESSAGE_CREATE
and MESSAGE_REACTION_ADD packets and drains them; `segments` splits the largest
channel into adjacent snowflake ranges that share its SDK handlers (`shared`) or not
(`independent`), the measurement behind cancelling channel segmentation (C9); `rescan`
runs a full backup, then measures a second one over the stored archive, which orders
its sources by stored work. Each scenario verifies stored reaction lists against the
source.
Sizes: `--largest` (2000) and `--small` (300) messages in one large and
`--small-channels` (3) small channels, `--reaction-rate` (0.1), `--concurrency`
(2), `--runs` (3), `--live-creates` (100), `--live-reactions` (50), `--segments`
(`1,2,4`). `--largest-last` discovers the large channel last instead of first.
`--channel-mutex` restores one admission resource per channel and
`--discovery-order` restores discovery-order full backups, for comparison.

`reobserve.ts` times the same fenced write of `observedAt` on 20,000 stored messages
as a replacement and as a `$set` in 100-document bulk writes, then the repository's
batch path on identical re-observations (`--count`, `--runs`). `storage.ts` builds a
synthetic static tree (`--files`, 100,000) beside a live MongoDB data directory,
times a full walk and the stable/live sampler, and measures the latency of small
reservations every 25 ms while samples expire (`--max-age`, 2000 ms; `--seconds`,
20).

```bash
node scripts/runtime.mjs exec ts-node --transpile-only tools/archive-benchmark/reobserve.ts /tmp/archive-reobserve.json
node scripts/runtime.mjs exec ts-node --transpile-only tools/archive-benchmark/storage.ts /tmp/archive-storage.json
```

## Statistics query probe

`stats.ts` measures the read-only `ArchiveStatsRepo` that backs `/traffic`. It loads
a deterministic synthetic guild (text channels, threads, forum posts, a skewed
author mix, replies, mentions, reactions with membership chunks, custom emoji,
stickers, bots and interaction records) into a disposable MongoDB 8.2.6, then times
the overview and member `activity` queries and the reactions-given, application,
emoji and sticker queries for 7-, 30- and 365-day windows (one warmup and three
measured runs each, all visible channels in the `$in` list):

```bash
node scripts/runtime.mjs exec ts-node --transpile-only tools/archive-benchmark/stats.ts /tmp/archive-stats.json --messages 1000000 --days 400
```

`--messages` and `--days` size the dataset (messages are spread evenly over the
days); `--cache-gb` sets the WiredTiger cache (default 1). Query time grows with the
messages inside the window, not the collection size, because every query is an
index range on `createdTimestamp`.

### Reservation reclamation comparison

This comparison disables only reservation shrinking in the first variant. Both
variants otherwise use the same executor, synthetic transport and delayed page
writer. Run serially on an idle host; no live Discord or database is accessed.

```bash
node scripts/runtime.mjs exec ts-node --transpile-only -e '
const { ArchivePipelineBudget } = require("./src/plugins/message-backup/flow/pipeline");
const { runArchivePipelineProbe } = require("./test/helpers/archive-pipeline-probe");
const reserve = ArchivePipelineBudget.prototype.reserve;
(async () => {
  for (const reclaim of [false, true]) {
    ArchivePipelineBudget.prototype.reserve = async function (...args) {
      const release = await reserve.apply(this, args);
      if (!reclaim) release.shrink = () => undefined;
      return release;
    };
    const trials = [];
    for (let i = 0; i < 5; i++) trials.push(await runArchivePipelineProbe({
      concurrency: 8, prefetch: true, channels: 8, pages: 10,
      requestLatencyMs: 5, writeLatencyMs: 20, quotaIntervalMs: 0,
    }));
    console.log(JSON.stringify({ reclaim, trials }));
  }
  ArchivePipelineBudget.prototype.reserve = reserve;
})().catch(error => { console.error(error); process.exitCode = 1; });
'
```
