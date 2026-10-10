# Archive performance benchmarks

Developer validation for the actual `ArchiveRepairService` audit, plan and verify paths.
The harness creates and destroys a dedicated localhost `mongodb-memory-server`
instance. It accepts no database URI, Discord token, operator configuration or
production input. Nothing is copied from a running archive.

Run with the existing project runtime, then compare the JSON report's three-run
median and range against the same dataset identity, Mongo version, index version,
write concern and cache mode:

```bash
node scripts/runtime.mjs exec ts-node tools/archive-benchmark/run.ts \
  --count 100000 --scenario clean --runs 3 --cache after-seed \
  --output /tmp/archive-baseline.json

node scripts/runtime.mjs exec vitest run --project tools tools/archive-benchmark
```

Use counts `100000`, `1000000`, and `5500000` for the planned scales. Smaller
counts are useful for smoke validation. Scenarios are `clean`, `bot-heavy`,
`duplicate-conflicts`, `old-timestamps`, `reaction-heavy`, `many-threads`,
and `live-updates`. Only run one benchmark at a time on a
shared host. Large dirty scenarios produce repair before/after images and can
take substantially longer than clean scenarios.

The default database budget is 1024 MiB. Increase `--max-db-mib` explicitly after
reviewing shared-host capacity. A conservative six-times-document-size preflight
estimate and free-disk reserve reject workloads outside the selected budget.
Seed batches stop at 500 documents or 4 MiB. Mongo uses a 0.25 GiB WiredTiger
cache, four database connections, and `w:majority,j:true`; repair execution is
serial. These are benchmark parameters, not operator defaults.

`after-seed` measures after dataset insertion and index preparation, without an
extra warm-up audit. `warm` adds one unmeasured audit. `mongo-cold` restarts only the
disposable mongod before each measured phase, clearing its WiredTiger cache.
All modes retain OS cache state; none claims an OS-cold read or drops host caches.
Mongo 8.2.6 is pinned and may require the existing
memory-server binary download on first use. The temporary database lives under
`/tmp` and is removed on normal completion or a handled error. Force-killing the
process can leave its disposable directory behind.

Reports include synthetic identity, implementation hash, indexes, cgroup limits,
durability, phase timing, DB command counts and logical BSON bytes, Node CPU,
sampled memory peaks, event-loop delay, GC, storage sizes and synthetic sort
execution stats. Command/reply payloads and per-message IDs are never retained in
metrics. BSON size monitoring has overhead; use the same instrumentation on both
sides of a comparison. Logical BSON bytes are not wire traffic. Node metrics do
not include the Mongo process or other bots. On Linux, a separate 100 ms sampler
records the disposable mongod's CPU and RSS using its server-reported PID.

`--batch-documents 100`, `500` or `1000` compares planning-journal batches with a
4 MiB target. A single larger recovery image uses a singleton batch up to the
existing 15 MiB safety limit. The product default remains 500; this developer flag
does not change operator configuration. Verify runs against the planned manifest
without applying it, so unapplied repairs or absent Discord coverage can truthfully
return partial. It measures the verification path, not successful coverage acceptance.

This DB harness does not exercise Discord quotas, real permission discovery,
history fetching, normal/burst membership REST requests, inbox backlog or
shutdown drain. Permission loss and discovery races are covered by isolated tests.
Reaction data tests serialization costs, and thread data tests channel
cardinality. `live-updates` issues at most 100 synthetic concurrent DB edits per
phase; it is not a gateway pipeline test. The report states these limitations.
Operator-facing workflows remain documented in
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
medians. It uses the actual notifier/renderer with a 5-second logical cadence,
isolated majority/journaled progress writes and mock payload encoding; remote
Discord latency is outside its claim. In-flight publication,
retry, coalescing and terminal drain behavior are tested independently.

Results and adoption decisions are recorded in the
[performance report](../../docs/contributing/archive-performance-results.md).

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

## Durable enrichment batching comparison

Compare the real archive repository and repair service using a disposable local
MongoDB 8.2.6 server:

```bash
node scripts/runtime.mjs exec ts-node tools/archive-benchmark/enrichment.ts \
  --count 1200 --runs 3 --output /tmp/archive-enrichment.json
```

The harness accepts no database URI. Each trial uses a fresh database, seeds the
same synthetic human messages, edits 10% of their content, and observes empty
reaction memberships. The serial baseline writes each snapshot and its empty
reaction publication separately. The batched path prepares 100-message pages,
combines empty-membership freshness with the snapshot, and uses the actual durable
repair journal and ordered bulk writes. Trial order alternates to reduce order
bias; at least three trials per mode are required.

The measured window includes repository enrichment and journal writes, with
separate accumulated journal and write/readback/acknowledgement timings. It excludes
seeding, planning, final verification, and Discord REST. Every trial must pass the
real repair verifier, preserve the expected revision count, and produce the same
final message digest. The JSON report includes elapsed-time and throughput ranges,
MongoDB command counts, journal-operation counts, source hashes, and runtime
versions. These results measure storage throughput for this workload and do not
predict end-to-end Discord backup speed.
