# Archive performance evidence

## Bounded enrichment batches and atomic empty snapshots, 2026-10-08

A synthetic comparison exercises the real repository snapshot path and repair
service, including durable journals, conditional target writes, readback and final
verification. It does not use production messages or Discord. Each of three paired
trials starts an isolated database with the same 1,200 messages; 120 have changed
content requiring a retained revision. The serial baseline writes snapshots and
empty reaction publication separately. The batch path prepares 25 independent
snapshots with atomic empty publication and uses the same recovery guarantees.
All six final message digests match and each trial verifies 120 revisions.

Environment: Node 22.13.0, MongoDB 8.2.6; measured 2026-10-08 09:25 UTC. Timings cover
enrichment only; initialization, planning and final verification are outside the
timer. Both variants run the real final verification successfully.

| Measurement                    |          Serial median |       Batch median |
| ------------------------------ | ---------------------: | -----------------: |
| Enrichment wall time           |           7,971.232 ms |         829.276 ms |
| Observed range                 | 7,762.457–8,221.725 ms | 757.161–863.370 ms |
| Messages per second            |                150.541 |          1,447.045 |
| Database commands              |                 30,242 |                602 |
| Journal operations             |                  2,520 |              1,320 |
| Journal stage time             |           3,124.743 ms |         208.021 ms |
| Target write/verify stage time |           3,533.771 ms |         432.019 ms |

This workload's enrichment stage is 9.612 times faster, with 98.01% fewer database
commands and 47.62% fewer journal operations. These are not end-to-end Discord
speedup claims: nonempty memberships, quotas, existing collection/index size,
filesystem durability latency, live traffic and policy exclusions change the mix.
Stage durations are nested and must not be summed with the encompassing wall time.
See the [reproduction instructions](../../tools/archive-benchmark/README.md) for
source fingerprints, fixture details and the machine-readable output contract.

The integrated implementation preserves bounded mutation batches, indexed
complete-image CAS and revision-before-message ordering. Checkpoints do not advance
on a failed or cancelled page. Tests cover partial ordered writes and resume,
rollback conflicts, dirty/gap changes between write waves, duplicate identities,
large-image fallback, tombstones and schema upgrade counters. Historical mixed
update counts remain mixed; incomplete-page resumes label outcome counts partial.

Integrated validation passed all eight local quality gates, with 324 test files /
3,474 tests and no skips, including both isolated migration drills. Statement/line
coverage was 88.67%, branch coverage 89.14% and function coverage 92.94%; existing
thresholds passed unchanged. Security checks passed with the existing nine
low/moderate advisories and no high/critical advisories. Production deployment is
separate from this synthetic and local validation.

## One-shot enrichment query and empty-reaction fix, 2026-10-08

Read-only inspection of the deployed one-shot executor confirmed that its
conditional replace/delete filter compared the entire document without an
indexable identity predicate. MongoDB's query planner selected `COLLSCAN` on a
message collection containing approximately 5.54 million documents. Adding `_id`
equality selected `IXSCAN` while retaining the same complete-image comparison.
No production mutation, explain execution scan, service restart or deployment was
used for this diagnosis. Operator configuration already used concurrency 8.

The fix anchors single enrichment writes by `_id`, matching the bounded candidate
lookup used for batch apply and rollback. Regression tests cover replacement and
deletion with ObjectId, string and embedded-document identities, assert one
examined document/key, and reject stale recovery images.

An isolated MongoDB 8.2.6 / Node 22.13.0 comparison used 100,000 synthetic documents
with the target inserted last, one warmup and five execution-stat samples per
predicate:

| Predicate              | Documents examined | Keys examined |                    Reported query time |
| ---------------------- | -----------------: | ------------: | -------------------------------------: |
| Complete image only    |            100,000 |             0 |              39 ms in all five samples |
| ID plus complete image |                  1 |             1 | 0 ms at MongoDB millisecond resolution |

The zero measurement is below the timer's resolution, not zero cost. This is
candidate-selection evidence, not a whole-backup benchmark or a claimed
100,000-fold end-to-end speedup. The integration regressions reproduce the
index-selection invariant with small fixtures:

```bash
npm run test:int -- test/integration/plugins/message-backup/repair.int.test.ts test/integration/plugins/message-backup/apply-batch.int.test.ts
npm run test:int -- test/integration/plugins/message-archive-reaction-progress.test.ts
```

Both scan types also remove an unnecessary stale mutation for trusted empty
reaction observations. Empty membership publication still removes old references;
message/gap fencing is checked again inside the serialized writer. Reaction
mutations drop from two to one for this path, or three to two message mutations
when including the snapshot. Tests cover previous membership removal and
invalidated evidence, cancellation while queued, and real backfill/apply/rollback.
Recovery chunks are retained for rollback.

The integrated rollback test also exposed a fallback-discovery defect: an absent
optional `passes` field was serialized as `undefined`, causing a persisted
recovery image to disagree with the target after-image. Discovery now omits that
field when unknown. Both complete and fallback inventories pass the same
one-shot/rollback regression.

Remaining costs include per-mutation durable enrichment journals, metadata writes
for content-unchanged messages, Discord membership requests and live inbox work.
The existing planning and mock-pipeline benchmarks below did not exercise the
unindexed enrichment write against a large collection; their earlier speedups did
not establish production one-shot throughput. Periodic direct writes already had
an identity predicate and do not share that specific query defect. Startup/gap
reconciliation and partial-pass retries remain conservative; see
[operational boundaries](../message-archive.md#periodic-schedule).

Validation after these fixes passed all eight local gates: `typecheck`,
`typecheck:emit`, `lint`, `format:check`, `handlers:gen:check`, `test:coverage`,
`knip` and `security`. Coverage ran 322 files / 3,435 tests without skips, including
both opt-in isolated MongoDB migration drills. Overall statement/line coverage
was 88.51%, branch coverage 88.97% and function coverage 92.82%; existing thresholds
passed unchanged. The security gate reported nine existing low/moderate advisories
and no high/critical advisories. GitHub-only checks were not run; no commit, push
or production deployment was performed.

## Component review and relation-query batching, 2026-10-06

The review covers discovery, history reads, normalization, persistence, reaction
enrichment, repair, verification and notification delivery. It identifies measured
avoidable work; it does not establish a theoretical optimum or a production
end-to-end backup duration. Discord quotas, source contents, storage latency and
concurrent live work remain workload-dependent limits.

| Component                 | Current efficiency decision and boundary                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery                 | One fresh SDK inventory per sweep; raw fallback only when required. Coverage and permission checks remain mandatory.                                      |
| History                   | Bounded per-channel prefetch and shared admission overlap reads with persistence; early reservation shrinking releases unused logical capacity.           |
| Normalization             | Owner-side execution remains justified by the CPU-pool measurements below; startup and memory costs outweighed complete-workload gains.                   |
| Persistence               | Batched snapshot preloads and unchanged-image write avoidance retain full-image conditional mutations, serialized ownership and durable acknowledgements. |
| Reactions                 | Bounded paginated membership reads discard unused user profiles. Generation completeness and dirty-watermark validation cannot be skipped for speed.      |
| Repair planning           | Excluded-message relation queries are now batched within 500-document / 4 MiB bounds, with streamed results and per-message dependencies.                 |
| Verification and recovery | Journal hashes, mutation readbacks and conditional rollback remain correctness work; arbitrary parallel writes would weaken recovery.                     |
| Progress                  | Actual activity counters are sampled by the existing ten-second heartbeat; per-page activity updates add no Discord notification calls.                   |

An additional comparison used the existing repair benchmark with 10,000 synthetic
bot-heavy messages, `after-seed` cache mode and three serial plans per variant.
Environment: Node 22.13.0, MongoDB 8.2.6, majority/journaled writes, four connections
and a 0.25 GiB WiredTiger cache. Both variants used fixture identity
`a7393effcbbe8024ccf605d9074a8f8964257feb4d3e05553d6d44f805ace577`.

| Plan metric         | Per-message relation queries | Batched relation queries |
| ------------------- | ---------------------------- | ------------------------ |
| Median milliseconds | 3,280.80                     | 370.87                   |
| Range milliseconds  | 3,266.52–3,559.86            | 367.17–407.24            |
| Find commands       | 16,033–16,034                | 53                       |

This planning fixture became 8.85 times faster, reducing elapsed time by 88.70%.
All trials completed with 8,000 operations, zero unresolved records, zero issues
and 5,976,000 journal bytes; insert/update command counts remained 17/33.
The fixture contains no related records, so it primarily measures avoided empty
lookups. Integration tests separately exercise related records, duplicate sources,
document/byte boundaries, cancellation, apply and rollback. It does not measure
Discord traffic or imply the same speedup for a complete backup.

[Full before/after reports](archive-repair-relation-evidence.json) preserve source
hashes, timing ranges and command counters. Reproduce using the
[repair probe](../../tools/archive-benchmark/README.md) with
`--count 10000 --scenario bot-heavy --runs 3 --cache after-seed`; output paths must
be separate for each implementation. No production data or service was used.

Integrated validation for this review passed all eight local project gates:
`typecheck`, `typecheck:emit`, `lint`, `format:check`, `handlers:gen:check`,
`test:coverage`, `knip` and `security`. Coverage passed 309 files / 3,112 tests
with no skips, including disposable migration tests; statement/line coverage was
87.72%, branch coverage 88.63% and function coverage 92.47%. Security reported
nine low/moderate advisories and zero high/critical advisories. GitHub-only
Gitleaks and CodeQL were not run; no commit, push or deployment was requested.

## Incremental pipeline review, 2026-10-06

The existing history executor probe compared fixed reservations against early
reservation shrinking. Both variants used the same current discovery path,
prefetch enabled, eight channels/readers, ten 100-message pages per channel,
5 ms synthetic REST latency, 20 ms page persistence latency and no mock quota.
Only `PipelineReservation.shrink` was replaced with a no-op for the fixed variant.
Five runs per variant were executed serially on the same host.

| Reservation policy | Trials, milliseconds    | Median, milliseconds |
| ------------------ | ----------------------- | -------------------- |
| Fixed maximum      | 366, 356, 359, 372, 359 | 359.13               |
| Shrink after read  | 263, 257, 256, 258, 255 | 257.46               |

The median decreased by 28.31%. Every run committed 8,000 messages, made 92
successful synthetic requests and reported no issues, with identical output digest
`bc9e741dd53436cca23d69cf508f4bb15a1cae499f36d0d69eb81a22945ae8a1`.
Both variants peaked at 56 MiB of reserved history capacity; the benefit is earlier
reuse during slow persistence, not a lower peak or a measured reduction in RSS.
This isolates the budget change, not production Discord or MongoDB throughput.

Separately, normal channel inventory now uses one SDK guild-channel request per
sweep instead of an SDK request followed by a duplicate raw request. The two-sweep
history pass saves two requests in this case. Unsupported SDK channel types and
SDK failures still trigger the raw fallback and retain coverage gaps. This request
count is verified by regression tests, not included in the timing comparison.
Adjacent page boundaries also avoid a duplicate control/inbox check; durable
checkpoint and reaction completeness rules are unchanged.

Reproduce the budget comparison with the existing
[pipeline probe](../../tools/archive-benchmark/README.md#reservation-reclamation-comparison).

## Scope and reproducibility

These 2026-10-01 measurements use synthetic data and disposable standalone MongoDB
instances. No production database, Discord request, deployment or live repair was
performed. Reproduction commands are in the [benchmark guide](../../tools/archive-benchmark/README.md).
The [machine-readable evidence](archive-performance-evidence.json) retains full
reports, source hashes, dataset identities, command counters and measurement ranges.

Database runs use Node 22.13.0, MongoDB 8.2.6, `w:majority,j:true`, four connections,
a 0.25 GiB WiredTiger cache and the synthetic `{messageId:1,_id:1}` ordering index.
Each variant runs three repetitions, serially. The shared host reports 12 logical
CPUs and approximately 32 GiB RAM; cgroup limit files were unavailable. Other host
workloads were not controlled. Timing includes BSON command-size instrumentation.
Logical BSON bytes are not wire traffic. Node and disposable mongod CPU/RSS are
separate samples; sampled peaks are lower bounds, not whole-host attribution.

All durations below are seconds: median (minimum–maximum). `after-seed` follows
insertion/index construction; `warm` adds an unmeasured audit. `mongo-cold` restarts
only the disposable mongod before each phase. No mode evicts OS caches, and later
repetitions can benefit from filesystem caching. The indexed-sort explain is
included; it does not profile every aggregation or isolate journal fsync latency.

## Repair planning comparison

| Dataset                | Original plan             | Final plan          | Median speedup | Find commands, original → final |
| ---------------------- | ------------------------- | ------------------- | -------------- | ------------------------------- |
| 100k clean             | 20.351 (20.264–20.353)    | 0.930 (0.913–0.964) | 21.89×         | 100005 → 6                      |
| 1m clean               | 202.191 (201.959–202.980) | 8.258 (8.197–8.314) | 24.48×         | 1000005 → 35–36                 |
| 100k timestamps        | 27.298 (27.201–27.942)    | 1.366 (1.340–1.511) | 19.98×         | 120005 → 29–30                  |
| 100k clean, Mongo cold | 20.277 (20.270–21.294)    | 0.941 (0.892–0.952) | 21.54×         | 100005 → 6                      |

Paired plans returned identical status, result counters and issue counts in all
repetitions. Clean fixtures produce no repair operations; timestamp fixtures
produce 10,000 operations. This is aggregate plan equivalence, not proof about
production data. Mutation, partial-bulk recovery, conditional rollback, journal
acknowledgements and live-write races are covered by separate integration tests.

The original 100k harness counted one manifest-validation find outside its timing
window; the table subtracts it. Subsequent original/final measurements freeze DB
counters at the measured boundary. The original executor was preserved before
editing, with SHA-256
`4b7b61a95c01030288e73025a1e6f96bffdc6015005b681a1cafa429fcabd224`.
Final reports identify all five repair implementation modules and reject source
changes during a measurement.

## Scale, scenarios and batch sizing

| Clean dataset | Audit                  | Plan                   | Verify                 | Plan peak RSS MiB, Node / mongod |
| ------------- | ---------------------- | ---------------------- | ---------------------- | -------------------------------- |
| 100k          | 0.845 (0.817–0.973)    | 0.930 (0.913–0.964)    | 0.859 (0.830–0.908)    | 764.3 / 277.9                    |
| 1m            | 8.942 (8.858–9.146)    | 8.258 (8.197–8.314)    | 8.340 (8.283–9.436)    | 329.0 / 609.3                    |
| 5.5m          | 63.888 (63.531–64.040) | 44.954 (44.498–45.754) | 62.344 (62.289–63.427) | 328.3 / 1115.6                   |

Verify measures the planned manifest without applying mutations or establishing
Discord coverage, so a partial result is expected. Audit and verify numbers are
reported separately; the plan speedup is not attributed to those phases.
The 5.5m run establishes final-executor scale, without claiming an unmeasured
5.5m original-executor speedup.

Each following scenario contains 100,000 synthetic messages:

| Scenario            | Plan                   | Operations | Unresolved | Outcome  |
| ------------------- | ---------------------- | ---------- | ---------- | -------- |
| old-timestamps      | 1.366 (1.340–1.511)    | 10,000     | 0          | complete |
| bot-heavy           | 32.884 (32.731–32.993) | 80,000     | 0          | complete |
| duplicate-conflicts | 1.120 (1.031–1.131)    | 4,000      | 1,000      | partial  |
| reaction-heavy      | 6.022 (5.947–6.040)    | 0          | 0          | complete |
| many-threads        | 0.831 (0.820–0.854)    | 0          | 0          | complete |
| live-updates        | 0.938 (0.899–1.161)    | 0          | 0          | complete |

Reaction-heavy data measures serialization/DB work, not REST membership fetching.
Thread-heavy data changes source cardinality. Missing permissions, moved/deleted
sources and incomplete discovery are exercised by mock tests. Live updates issue
at most 100 synthetic edits per phase, with one in-flight update at a time;
their largest observed DB
completion latency was 19.3 ms. This is not production Gateway inbox latency.

| Timestamp batch documents | Plan                | Insert commands | Update commands | Node peak RSS MiB |
| ------------------------- | ------------------- | --------------- | --------------- | ----------------- |
| 100                       | 1.404 (1.392–1.431) | 101             | 201             | 329.7             |
| 500                       | 1.366 (1.340–1.511) | 21              | 41              | 339.5             |
| 1000                      | 1.326 (1.323–1.376) | 11              | 21              | 335.8             |

Retain the conservative product default of 500 documents / 4 MiB per batch.
Larger individual recovery images remain singleton batches up to the existing
15 MiB safety limit. Complete before-images and durability are preserved.
For 100k clean plans, Mongo-cold measured 0.941 (0.892–0.952); explicit warm measured 0.839 (0.830–0.868).
Neither supports an OS-cold performance claim.

## History pipeline and REST admission

The actual history executor and scheduler processed the same 8,000 synthetic
messages with 94 successful mock requests, 5 ms request latency and 5 ms page-write
latency. Every variant produced the same committed-ID digest, no coverage issue
and zero remaining byte reservations. Prefetch-off is the sequential-page
comparison, not a different data consumer.

| Shared mock ceiling | Concurrency | Prefetch off        | Prefetch on         |
| ------------------- | ----------- | ------------------- | ------------------- |
| None                | 2           | 0.520 (0.517–0.525) | 0.301 (0.301–0.304) |
| None                | 4           | 0.275 (0.271–0.276) | 0.183 (0.180–0.185) |
| None                | 8           | 0.178 (0.174–0.178) | 0.176 (0.172–0.177) |
| 200 requests/s      | 2           | 0.539 (0.537–0.543) | 0.484 (0.483–0.486) |
| 200 requests/s      | 4           | 0.478 (0.477–0.478) | 0.478 (0.478–0.479) |
| 200 requests/s      | 8           | 0.479 (0.479–0.480) | 0.479 (0.477–0.480) |

The 200 requests/s mock ceiling has a 470 ms request-service lower bound for 94
requests. Increasing concurrency beyond saturation gives no useful quota gain.
Retain default 2 and maximum 8; evidence does not justify 12/16. Staged history
reservations peaked at 56 MiB inside the shared 64 MiB budget, with 8 MiB reserved
for reactions. These logical limits exclude temporary SDK/V8 allocation and are
not process-RSS limits. Oversized history pages remain partial without premature
checkpoint advancement.

The separate admission probe verified per-resource exclusion and guild fairness
with local announced waits; maximum observed live admission latency was
0.46 ms. These are mock transport results. Actual 429 responses and SDK
wait announcements remain separate telemetry; no real Discord ceiling is inferred.

## CPU worker adoption decision

CPU offloading is **not enabled** in the product. The pure probe includes owner
BSON encoding, complete snapshot replies and hash equivalence. Small/large pure
workloads contain 20,000 × 64-byte and 5,000 × 32-KiB bodies. Persistence workloads
contain 2,000 and 500 messages and use the real archive repository with all
archive schema indexes created before timing. Pools run in
sequence in one process; retained allocator memory can influence later RSS peaks.
Worker environments are empty and contain no inherited credentials.

| Pool | Small CPU stage     | Large CPU stage     | Small persisted     | Large persisted     | Persistence peak RSS MiB |
| ---- | ------------------- | ------------------- | ------------------- | ------------------- | ------------------------ |
| 0    | 0.395 (0.388–0.440) | 1.431 (1.415–1.458) | 0.525 (0.481–0.689) | 0.328 (0.314–0.344) | 654                      |
| 1    | 0.613 (0.586–0.664) | 1.510 (1.506–1.610) | 0.482 (0.475–0.537) | 0.370 (0.356–0.405) | 939                      |
| 2    | 0.354 (0.341–0.424) | 0.852 (0.823–0.894) | 0.477 (0.462–0.488) | 0.300 (0.300–0.303) | 1139                     |
| 4    | 0.221 (0.200–0.286) | 0.638 (0.611–0.698) | 0.471 (0.467–0.485) | 0.270 (0.265–0.275) | 1512                     |

Reusable workers improve some warm CPU stages, especially large messages.
However, startup adds approximately 1.2–2.0 seconds, warm persisted gains are
workload-dependent, and sampled process memory rises substantially. Including
startup makes these complete test workloads slower. The evidence does not justify
adding a production pool and its memory/ownership complexity for the current
default workload. This is measured non-adoption under the plan's adoption gate,
not an unfinished pool implementation or a claim that workers can never help.
The asynchronous I/O pipeline remains active with the owner performing CPU work.

## Notification overhead and recovery checks

The publication probe compares identical normalization of 100,000 messages,
snapshot collection and event-loop yields. It uses the actual notifier and English
renderer, isolated majority/journaled progress writes and mock payload encoding.
A 5-second cadence over a 50-second logical clock produced 11 delivered snapshots.
An initial warmup pair is excluded; enabled/disabled order alternates.

Disabled delivery: 2.382 (2.362–2.421). Enabled delivery:
2.409 (2.376–2.425). Median throughput loss:
**1.10%**, below the 5% target in this fixture.
Real Discord latency is outside this claim. Separate tests cover slow/failing
publication, bounded latest-value coalescing, terminal drain, heartbeat cadence,
restart references and stale generation suppression.

Cancellation checks coalesce at a 250 ms maximum cached age and local abort
interrupts a pending lookup. Fault tests cover cancellation at page/write/checkpoint
boundaries; already-issued remote writes complete their recoverable acknowledgement
path. No test promises instantaneous cancellation of an in-flight remote operation.
Writer wait, pipeline stages/bytes, inbox age, owner renewal and shutdown drain
remain bounded numeric diagnostics without message bodies or signed URLs.

New journal version 2 preserves before/after image semantics while allowing
sequence reservations. Legacy runs retain their original handler; older runtimes
reject new runs through the schema identity. See [upgrade contracts](../upgrading.md#archive-batching-and-progress-contracts)
and [operational recovery](../message-archive.md#capacity-and-recovery).

## Integrated validation

All six implementation tasks are complete, including measured CPU-pool
non-adoption. Final local validation passed on 2026-10-01: `typecheck`,
`typecheck:emit`, `lint`, `format:check`, `handlers:gen:check`, `test:coverage`,
`knip` and `security`. Coverage passed 282 files / 2,692 tests with no skips,
including both opt-in migration restore tests against disposable databases.
Overall statement/line coverage is 85.42%, branch coverage 87.72% and function
coverage 91.42%; all configured thresholds passed without changes.

The configured security gate passed with eight existing low/moderate dependency
advisories and no high/critical advisories. GitHub-only Gitleaks and CodeQL were
not run because no commit or push was requested. No production scan, service
restart or deployment was performed.
