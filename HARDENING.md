# Hardening Log

This repository was audited, found to have real defects, and remediated. This
file records what was wrong, what changed, and what it cost, because a
portfolio project that claims production discipline should be able to show its
own bug history rather than only its best state.

Every item below is traceable to a commit and covered by a test that fails if
the fix is reverted.

---

## The defect that mattered: idempotency lost webhook deliveries

**Severity:** silent data loss reported as success.

The idempotency table was keyed on `key TEXT PRIMARY KEY`, and
`hasBeenProcessed(key)` ignored `job_name` even though the column existed and
was populated.

Clients choose their own idempotency keys, and nothing stops the same business
identifier (an order id) being reused across job types. The producer prefixes
BullMQ job IDs by type (`email_<key>`, `webhook_<key>`), so two jobs sharing a
client key are **two distinct jobs that both enqueue and both reach a
processor**. The prefix is precisely what made the collision reachable.

The webhook processor checks idempotency *before* `fetch()`. On collision it
short-circuited, made no HTTP request at all, and returned:

```json
{ "success": true, "isDuplicate": true }
```

A webhook that was never delivered was reported as a success to the caller, to
the dashboard, and to the metrics.

**Fixed by:** a composite `(job_name, key)` primary key, `job_name` threaded
through every read, and `ON CONFLICT(job_name, key)` on both upserts.

**Migration:** `CREATE TABLE IF NOT EXISTS` does not alter an existing table, so
an already-deployed database would have kept the old key and the bug. The demo
runs on an ephemeral filesystem and would have self-healed on redeploy, but a
correctness guarantee that depends on the host wiping the disk is not a
guarantee. `migrateIfLegacySchema()` rebuilds the table in place, and
`tests/idempotency.migration.spec.ts` covers it against real legacy databases.

**Proof:** the collision tests were run against the pre-fix `src/` and fail.
The central assertion is on the delivery sink's hit count, not the return
value; the bug was that no HTTP request happened, and a test checking only the
response shape would have passed while deliveries were still being dropped.

**What it taught me:** the audit I was working from called this "low probability,
because BullMQ job IDs are prefixed." That inverts the mechanism. Prefixing was
the enabling condition, not the mitigation. A plausible-sounding reason to
deprioritise a bug is worth checking as carefully as the bug.

---

## Dead reliability code the architecture diagram claimed was live

`recordFailure()` had exactly one reference in the repository: its own
definition. The `FAILED` status was unreachable.

It was not merely unused. `docs/architecture.md` documented `Worker->>DB:
recordFailure(...)` as part of the failure path; the diagram described a
control flow the system did not perform. The adjacent line still read `Throw
Error (Simulated or Runtime)`, stale text referring to the `simulateFailure`
switch this repo removed and has regression tests against.

Given the choice between deleting the method and honouring the diagram,
honouring it was better: a terminal failure record is genuinely useful, and it
makes the document true rather than shorter. It now fires only when
`attemptsMade >= maxAttempts`, immediately before DLQ routing, recording
per-attempt would mark a job `FAILED` while a retry was still pending.

---

## Observability: correlation IDs end to end

The queue logged `jobId`, but nothing connected a job to the HTTP request that
created it. Given a DLQ entry there was no way back to the intake call; given a
user's bug report, no way forward to the job.

`x-correlation-id` is now accepted at intake (sanitised: 64-character cap,
`[A-Za-z0-9_-]` only, discarded rather than repaired if it survives nothing),
generated when absent, echoed on the response and in the 202 body, carried on
the job payload across the process boundary, and re-entered in **both** the
worker's processor callback and its `failed` handler, event handlers fire
outside the processor's scope, so without that the failure and DLQ lines would
have been the only untagged lines on the path.

A Pino `mixin()` attaches it to every log line, so no call site changed.

**Design note worth stating:** `correlationId` is deliberately *not* in the
public job schemas. Those stay `.strict()` and correlation-free, so a client
putting it in a request body gets a 400, the same posture this repo takes on
`simulateFailure`. An earlier draft of the change added it to the public
schemas, which would have let a caller forge one through the job body while
the doc comment claimed they could not. The `*RecordSchema` split is what
makes "server-resolved, cannot be forged" actually true.

---

## Telemetry that was honest but easy to misread

Neither counter was wrong; both invited the wrong reading, and being misread on
telemetry is the specific failure this repo has already been burned by.

| Counter | Was read as | Actually counts |
|---|---|---|
| `jobs_failed_total` | failed jobs | failed **attempts**; one job retried to exhaustion adds 3 |
| `jobs_processed_total{status="success"}` | work performed | includes idempotent duplicates that never ran their side-effect |

Both caveats now live in the metric `help` text, so they travel with the scrape
into Grafana's metric browser rather than living only in a README.

---

## The simulated email, said out loud

The `EMAIL_NOTIFICATION` processor performs **no** real side-effect. No SMTP
provider is contacted; the `messageId` is generated locally so the idempotency
record has a realistic payload to replay.

The webhook processor documented at length that its failure was real. The email
processor said nothing, and that asymmetry invited the inference that this
service sends mail. It now says so at the side-effect itself, and in the README
directly under the dispatch example.

The asymmetry is deliberate: exactly one of the two processors performs real
I/O, and it is the one making the retry and DLQ claim. `WEBHOOK_DELIVERY` issues
a genuine HTTP `POST` to a path the service deliberately does not serve, so
backoff and dead-lettering rest on a real failure rather than a simulation flag.

---

## What is still demo-grade, deliberately

- **Email is simulated.** Above. A real provider behind a feature flag is the
  obvious next step; it was not taken because it adds a credential to a
  deployment whose value is that it runs unattended.
- **Single instance.** HTTP rate limiting is in process memory. Multi-instance
  would need a shared store.
- **Bull Board is unauthenticated and read-only.** A deliberate public surface,
  guarded by `dashboardReadOnlyGuard` and a snapshot cache rather than by auth.
- **Redis budget tuning is calibrated to one host.** The `drainDelay` /
  `stalledInterval` values are load-bearing for the Upstash free tier and are
  documented as such; they are not general-purpose defaults.

---

## Production rollout

Deployed 2026-08-28 by auto-deploy on merge to `main`. Runbook:
[docs/deployment.md](docs/deployment.md).

**What shipped:** the `(job_name, key)` idempotency fix with its in-place schema
migration, the wired `recordFailure`, correlation IDs across HTTP → queue →
worker → DLQ, and the corrected metric help text.

**The deploy was clean**; no failed builds, no rollback. This repo already had
the build command the other two needed (`npm ci --include=dev && npm run build
&& npm prune --omit=dev`), which is why it was the only one of the three that
required no deploy-config work.

Verified live: `/health` reports `redis`, `sqlite` and `worker` all `UP` and
carries `x-correlation-id`; a dispatch through the Netlify proxy returns a
`correlationId` alongside the `jobId`; and a payload carrying the removed
`simulateFailure` field is still rejected with a 400.

**What to monitor.**

- `task_queue_jobs_failed_total` counts failed **attempts**, so divide by the
  retry limit before reading it as a job count. Terminal failures are countable
  from the DLQ, and DLQ depth is the number that actually means something is
  wrong.
- `task_queue_jobs_processed_total{status="success"}` includes idempotent
  duplicates. A rising duplicate rate means clients are retrying, not that
  throughput improved.
- `task_queue_dashboard_snapshot_total{source="redis"}` versus `source="cache"`
  is the Redis budget signal. A rising `redis` count means snapshots are being
  invalidated more often than the projection in `docs/design_decisions.md`
  assumed, and is the first place to look if the Upstash command counter climbs.

---

## Method

Each fix followed the same sequence, and the sequence is the point:

1. Write the guard first and **run it against the unfixed code** to watch it
   fail. A check that cannot fail is not evidence.
2. Change the code.
3. Enumerate the blast radius from the typechecker rather than from memory ,
   the idempotency signature change surfaced six call sites, including one in a
   health probe that no test covered.
4. Update the documentation in the same branch. Docs are part of the contract;
   a claim that outlives the code that backed it is a defect.
