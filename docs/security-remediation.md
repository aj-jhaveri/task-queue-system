# Security Remediation & Redis Command Budget Analysis

This document records why the hardening changes exist, with the measurements behind
them. It is written to be re-derivable: every figure below can be checked against
the installed dependency sources.

---

## 1. Background

The previously provisioned Upstash Redis database accumulated roughly **498,334
commands** over approximately three days and effectively exhausted the free tier's
500,000 command/month allowance. Storage was ~20 KB and bandwidth was effectively
zero, indicating a very large number of very small operations rather than heavy
payload traffic.

Investigation identified two independent, sufficient causes, both reachable without
authentication, plus one structural cause present even with zero visitors.

---

## 2. The idle worker baseline

BullMQ's stock `Worker` defaults are `drainDelay: 5` (seconds) and
`stalledInterval: 30000` (ms), confirmed in
`node_modules/bullmq/dist/cjs/classes/worker.js`.

An idle worker's loop costs:

| Source | Mechanism | Rate | Commands/day |
|---|---|---|---|
| Blocking pop | `bzpopmin` on the marker key | 1 per 5s | 17,280 |
| Fetch attempt | `moveToActive` script after each nil-return block | 1 per 5s | 17,280 |
| Stalled checker | `moveStalledJobsToWait` script | 1 per 30s | 2,880 |
| **Total** | | | **37,440** |

`37,440 x 30 = 1,123,200 commands/month`, or **225% of the free tier cap, before a
single job is submitted**. Lock renewal contributes nothing while idle: the lock
manager only issues `extendLocks` when it is tracking active jobs.

### Why raising `drainDelay` is safe

Two properties make this tuning free of behavioral cost:

1. **Job pickup latency is unaffected.** BullMQ's job-add script writes a marker
   (`ZADD` in `scripts/addStandardJob-9.js`) that immediately satisfies the blocked
   `bzpopmin`. A longer `drainDelay` lengthens only *idle* blocks, never dispatch.
2. **Retry timing is unaffected.** When delayed jobs exist, `getBlockTimeout` takes a
   separate branch capped at 10 seconds internally, so exponential backoff keeps its
   accuracy regardless of `drainDelay`.

### Tuned baseline

| Setting | Value | Idle cost |
|---|---|---|
| `drainDelay` | 60s | 2,880/day |
| `stalledInterval` | 300000ms | 288/day |
| **Total** | | **3,168/day (~95,040/month, ~19% of cap)** |

`drainDelay: 300` would reduce this further (~864/day) but was **rejected**: it
maximizes exposure to Upstash closing idle sockets, which would trigger reconnect
churn (`AUTH` + `CLIENT SETNAME` + `INFO` per reconnect) and could cost more than it
saves. 19% of budget is ample headroom; optimizing further trades a verified win for
an unverified risk.

---

## 3. Bull Board polling: the dominant variable cost

`/admin/queues` was unauthenticated and its URL was published in the README.

Bull Board's bundled UI ships with a **5 second** polling default. Each poll costs
roughly 7 Redis commands across the two registered queues:
`getJobCounts` x2, `isPaused` (`hexists`) x2, `getGlobalConcurrency` x2, plus
`getJobs` for the active tab (`@bull-board/api/dist/handlers/queues.js`).

```
12 polls/min x ~7 commands = ~84/min = ~5,040/hour = ~120,000/day
```

**One forgotten browser tab consumed the entire 16,667/day free allowance in about
3.3 hours.** This is the single largest contributor to the original incident and
required no attacker: simply opening a link the README advertised was enough.

**Initial remediation (superseded):** HTTP Basic auth on the route, plus
`forceInterval: 60` via `uiConfig.pollingInterval`, reducing an open authenticated
tab to ~420 commands/hour.

That fix was withdrawn. It was solving the wrong problem in two ways. It made the
dashboard unusable for the only reason it exists — being shown to people — while
leaving the real hazard untouched: the mutating routes still existed, and safety
rested on a shared credential never leaking. And ~420 commands/hour still scales
linearly with viewers; three tabs would have put it back over budget.

**Current remediation:** the route is public again, with the boundary moved from
*who may look* to *what may be done*, and the cost made independent of how many
people look. See section 3b.

---

## 3b. Making an open dashboard structurally cheap

Five controls, each addressing a distinct failure mode:

**1. Mutation is impossible, not merely hidden.**
`readOnlyMode: true` on both `BullMQAdapter` instances is a UI flag, not a security
control — `POST /api/queues/:name/add`, `PUT .../obliterate`, `PUT .../empty`,
`PUT .../pause` and `PUT .../:jobId/retry` remain mounted and reachable with `curl`.
`dashboardReadOnlyGuard` refuses every non-`GET` method with `405` ahead of the Bull
Board router. Bull Board's entire read surface is `GET` and every state-changing
route is `POST`/`PUT`/`PATCH`, so this removes the mutation surface without
degrading the dashboard. The refusal is unconditional: valid admin credentials do
not unlock it.

**2. Cost is decoupled from viewers.**
`dashboardSnapshotCache` answers `GET /api/queues` — the only polled route — from an
in-process snapshot. Twenty concurrent viewers cost one Redis read, not twenty.
Because polls are served from memory, `forceInterval` was *lowered* to 10s for
responsiveness rather than raised for thrift.

**2b. A cache key is only valid if it identifies the response.**
A cache in front of an unauthenticated route has to answer two questions, and
getting either wrong is a defect:

*Can a caller force a miss?* An earlier revision keyed on `req.originalUrl` while
deciding cacheability from `req.path`. `req.path` excludes the query string, so
`/api/queues?junk=1` was cacheable but keyed differently from `/api/queues` — and
because Bull Board ignores unknown parameters entirely, a caller rotating one missed
on every request while receiving identical data. Measured against a local Redis with
the worker stopped:

| Window | Requests | Redis commands |
|---|---|---|
| One cold refresh | 1 | 26 |
| Identical URL, repeated | 20 | **0** |
| Rotating `?junk=N` | 20 | **520** |

At the 120/minute per-IP limit that is ~3,120 commands/minute from a single address,
which spends the 500,000 monthly allowance in under three hours without tripping a
limiter. A cache that only works for well-behaved callers is not a cost control.

*Does the cached body match the key it is stored under?* This is the question that
makes canonicalization subtle. Reducing the **key** alone is a cache-poisoning bug:
if `?page=999` still reaches Bull Board it builds a page-999 payload, that payload
gets stored under the canonical `page=1` key, and the next visitor asking for page 1
receives it for a full TTL. The parameters are therefore written back onto
`req.query` — the only surface `@bull-board/express` reads — so the request, the
response, and the key always describe the same view.

The request is reduced to the four parameters `@bull-board/api` actually reads
(`activeQueue`, `status`, `page`, `jobsPerPage`, verified against the installed
package), each validated: unknown parameters dropped, an unregistered queue name or
unknown status collapsed to the default view, `page` and `jobsPerPage` clamped to
1–100. The key space is a function of the views that genuinely exist rather than of
what a caller can type.

`jobsPerPage` is clamped to a range rather than snapped to a fixed list because the
UI's page-size control is a free numeric input: a visitor who chooses 15 must get
15, not be silently served 10. That leaves a wider key space than a fixed list
would — an accepted trade, since the hard bound on cost is the refresh budget below.

Both properties are pinned in `tests/dashboard.cache.spec.ts`, which asserts command
cost directly and uses an upstream stand-in that echoes the parameters it received.
Tests that count upstream calls cannot detect either failure: a bypass and a
mismatched body both look like ordinary cache activity from a call counter.

**2c. A global refresh ceiling bounds what remains.**
Canonicalizing the key removes the unbounded bypass but not the bounded one: the
legitimate view space is still a few thousand snapshots and sweeping it costs real
commands. Job intake already had a global ceiling alongside its per-IP limiter
(`globalJobLimiter`); the dashboard had only per-IP. `DASHBOARD_MAX_REFRESHES_PER_WINDOW`
(default 60 per 60s) caps snapshot *rebuilds* across all callers combined.

Past the ceiling the middleware serves the newest snapshot it holds for that exact
view, marked `X-Dashboard-Snapshot: STALE`. If it holds none, it refuses with `503`
and `Retry-After` rather than reach Redis — serving another view's data to fake
freshness would be worse than admitting the data is old. Cache hits are not charged
against the budget, so honest viewers are unaffected no matter how many there are.

The default is derived rather than picked: a rebuild can only follow a poll, and the
UI polls every 10s, so a single open view can trigger at most 6 rebuilds/minute even
if real job activity invalidates every one of them. 60/minute covers roughly ten
simultaneously active distinct views — far beyond what this service sees — while
capping the hostile case at ~1,560 commands/minute.

**3. Freshness comes from events, not timers.**
`invalidateDashboardSnapshot()` fires from the producer on every enqueue and from
the worker on `completed` and `failed`. The TTL (`DASHBOARD_SNAPSHOT_TTL_MS`,
default 900s) is only an idle backstop for transitions nothing observed, such as a
delayed job maturing. While the queue is idle nothing changes, so a cached snapshot
is the correct answer rather than a stale one.

Cost comparison for one continuously open tab:

One refresh costs a **measured 26 Redis commands** across the two registered
queues (10 `zcard` + 6 `llen` + 4 `lindex` + 2 `hexists` + 2 `hget` + 2 `evalsha`).
An earlier revision of this document assumed ~10 and understated every figure below
by roughly 2.6x — the reason each row is now measured rather than derived.

| Configuration | Refreshes/day | Commands/day | Commands/month |
|---|---|---|---|
| Stock Bull Board, 5s polling, uncached | 17,280 | ~449,000 | ~13,500,000 |
| Basic auth + `forceInterval: 60`, uncached | 1,440 | ~37,400 | ~1,123,000 |
| Snapshot cache, 5-minute backstop | 288 | ~7,490 | ~225,000 |
| Snapshot cache, 15-minute backstop (current) | 96 | ~2,500 | ~75,000 |

The current row is the *worst* case: a tab open permanently with the queue idle, so
every refresh is a backstop expiry rather than a real event. Add the ~95,000/month
idle-worker baseline and the total is roughly **170,000 of the 500,000 allowance**,
leaving ~330,000 for real job traffic.

The backstop was raised from 5 to 15 minutes once the per-refresh cost was measured
rather than assumed: at 5 minutes a single forgotten tab cost ~225,000/month, which
combined with the worker consumed two thirds of the allowance for a page nobody was
looking at. Raising it costs nothing in perceived freshness, because every state
change the system can observe invalidates the snapshot immediately - the backstop
only governs a queue where nothing is happening.

### How these numbers are measured

`CONFIG RESETSTAT` to zero the counters, run the window, then read `INFO
commandstats` and sum the per-command `calls`. Two things must be subtracted or
avoided or the result is meaningless:

- The Docker healthcheck issues its own `redis-cli ping` against the same instance.
- `CONFIG` and `INFO` calls made by the measuring harness itself are counted too.

Note when reproducing this: the test suite dispatches real jobs against the same
local Redis, so running `npm test` during a measurement window invalidates it. An
earlier attempt was discarded for exactly that reason. Stopping the worker isolates
dashboard cost from the worker's idle long-poll and delayed-set scan.

A previous revision measured a 106-second idle window in aggregate and apportioned
it between the dashboard and the worker by assumption. Those component figures do
not reconcile with the per-refresh cost measured directly, and have been replaced by
it rather than adjusted to fit.

**Residual risk.** Two paths remain bounded by something other than a hard control:

- **Job-detail routes** (`/api/queues/:queueName/:jobId`) are deliberately not
  cached, since they are opened by a human rather than a timer and should always be
  current. `dashboardLimiter` caps them per IP, but a distributed hammer is bounded
  only by that per-IP limit multiplied by the number of source addresses.
- **The bounded key sweep.** The refresh budget caps the *rate* at ~1,560
  commands/minute, not the total. Nothing here makes a sustained, distributed,
  month-long attack free; it makes it slow, visible, and incapable of exhausting the
  allowance in an afternoon. `task_queue_dashboard_snapshot_total{source="stale"}`
  and `{source="shed"}` are the signals that it is happening.

---

## 4. Job-submission amplification

`POST /api/jobs/email` and `POST /api/jobs/report` were unauthenticated with no rate
limiting. The schemas accepted a `simulateFailure` boolean, so one HTTP request
could force three attempts plus a dead-letter write:

```
add(1) + 3x[moveToActive + moveToFailed](6) + 2x delayed promotion(2) + DLQ add(1)
  ~= 10-14 Redis commands per request
```

At that ratio, reproducing the observed daily volumes required only **~9-13 requests
per minute** — trivially scriptable, and well within reach of a single unattended
loop.

A companion `delayMs` field allowed unbounded artificial processing delay, which at
`WORKER_CONCURRENCY=5` let five requests occupy every worker slot indefinitely.

**Both fields were removed from the system entirely**, rather than gated behind an
admin credential. A real queue should demonstrate retry and DLQ behavior through
real failures; controlled failures now exist only inside the test suite, injected
with mocks.

---

## 5. Findings and remediation

| # | Finding | Severity | Remediation | Verified by |
|---|---|---|---|---|
| 1 | Idle worker consumed 225% of the monthly Redis cap at BullMQ defaults | High | `drainDelay: 60`, `stalledInterval: 300000` | `tests/worker.spec.ts` pins both values |
| 2 | `/admin/queues` publicly reachable, unauthenticated, auto-polling every 5s | Critical | Snapshot cache decouples cost from viewers; `dashboardReadOnlyGuard` refuses all mutating methods; `readOnlyMode` on adapters. Dashboard remains public by design | `tests/dashboard.cache.spec.ts`, `tests/http.security.spec.ts` |
| 2b | Bull Board mutating routes reachable by hand despite `readOnlyMode` | Critical | `405` guard ahead of the router, unconditional | `tests/http.security.spec.ts` (10 method/route cases) |
| 2c | `/api/redis/stats` exposed raw Redis `INFO` on a public route | Medium | Route blocked with `404`; `hideRedisDetails` alone only stopped the UI from calling it | `tests/http.security.spec.ts` |
| 2d | Snapshot cache keyed on `req.originalUrl`, so a rotating query parameter forced a full Redis rebuild per request — measured 520 commands for 20 requests against 0 for 20 honest polls, enough to exhaust the monthly allowance in under 3 hours from one IP | High | Request reduced to validated `activeQueue`/`status`/`page`/`jobsPerPage`, written back to `req.query` so the cached body always matches its key | `tests/dashboard.cache.spec.ts` ("Cache key canonicalization") |
| 2e | Dashboard had a per-IP limit but no global ceiling, unlike job intake | Medium | `DASHBOARD_MAX_REFRESHES_PER_WINDOW` caps snapshot rebuilds across all callers; stale snapshot served past the cap, `503` when none exists | `tests/dashboard.cache.spec.ts` ("Global refresh budget") |
| 3 | `simulateFailure` let anonymous callers force retries + DLQ writes | High | Field removed; strict schemas reject it with 400 | `tests/queue.spec.ts`, `tests/http.security.spec.ts` |
| 4 | `delayMs` allowed unbounded worker-slot occupation | Medium | Field removed; strict schemas reject it | `tests/queue.spec.ts` |
| 5 | No HTTP rate limiting on job intake | High | Per-IP + global in-memory limiters | `tests/http.ratelimit.spec.ts` |
| 6 | Per-IP limiting would have been ineffective behind Render's proxy | High | `trust proxy` set to a specific hop count | `tests/http.ratelimit.spec.ts` (distinct-IP bucket test) |
| 7 | `Access-Control-Allow-Origin: *` on every route | Medium | Explicit env-configured allowlist; wildcards stripped at parse | `tests/http.security.spec.ts` |
| 8 | `/metrics` publicly exposed queue and process internals | Medium | Admin auth outside local development | `tests/http.security.spec.ts` |
| 9 | REDIS_URL parse errors logged the full connection string incl. password | High | Errors thrown without cause; Pino redaction; `redactSecrets` scrubber | `tests/config.security.spec.ts` |
| 10 | 500 responses returned raw internal error messages | Medium | Generic client body; details confined to server logs | `tests/http.security.spec.ts` |
| 11 | No queue-depth ceiling | Medium | `MAX_QUEUE_DEPTH` with demand-driven TTL-cached check | `tests/queue.depth.spec.ts` |
| 12 | Producer buffered commands indefinitely during a Redis outage | Medium | `enableOfflineQueue: false` on producer connections; 503 fail-fast | `tests/queue.depth.spec.ts` |
| 13 | DLQ retained entries forever (unbounded storage growth) | Low | 1,000 entries / 30 day retention | Config in `src/queue/dlq.ts` |
| 14 | No request body size limit | Low | `JSON_BODY_LIMIT` (16kb default) | `src/app.ts` |
| 15 | Postman collection was invalid JSON (unescaped quote) and shipped a DLQ-forcing request | Low | File rewritten; failure request replaced with a 400-demonstration | Manual JSON parse |

---

## 6. What was deliberately NOT done

- **No background queue-depth poller.** A 10-second timer would cost ~8,640
  commands/day (~259K/month) to watch an idle queue. Depth is read only inside a
  submit request, memoized for `QUEUE_DEPTH_CACHE_TTL_MS`.
- **No Redis-backed rate limiter.** It would spend Redis commands on the very
  requests it rejects, undermining the budget it protects.
- **No `drainDelay: 300`.** See section 2.
- **No operator-only failure endpoint.** Considered and rejected: it would have
  reintroduced a runtime failure switch, merely behind a credential.
- **No caller-supplied webhook URL.** The `WEBHOOK_DELIVERY` job takes a destination
  *name* from an enum, not a URL. On an unauthenticated endpoint a URL field would
  be an SSRF primitive pointed at cloud metadata or internal services. The defence
  is that no URL-shaped input exists, rather than that one is validated.
- **No client-side polling of job status in the demo page.** It would have made the
  page's pipeline tracker fully live, but at a per-dispatch Redis cost on an
  unauthenticated path. The page instead reports only what the dispatch response
  proves and hands off to the dashboard for execution state.
- **No authentication on the dashboard.** Reversed deliberately; see section 3b.

---

## 7. Post-deployment verification

After deploying, confirm the tuned baseline empirically:

1. An open Bull Board tab no longer needs to be closed for this measurement — that
   was a requirement of the superseded auth-based fix. With the snapshot cache an
   idle tab contributes approximately nothing, and confirming that is itself worth
   doing: take one reading with a tab open and one without, and expect them to
   match within noise.
2. Leave the service otherwise idle for 30 minutes.
3. Record the Upstash command counter at the start and at the end.
4. Expected delta: **~66 commands** (3,168/day / 48).
5. Account separately for known external health checks. UptimeRobot pinging
   `/health` every 5 minutes adds ~6 requests, costing ~0 Redis commands because a
   ready connection short-circuits before any `PING`.
6. If the delta is materially higher (several hundred), suspect reconnect churn from
   Upstash closing idle sockets before the 60-second block elapses. Reduce
   `WORKER_DRAIN_DELAY_SECONDS` to 30 and re-measure before declaring success.

### Steady-state expectations

| Scenario | Commands/month | % of 500K cap |
|---|---|---|
| Idle worker only | ~95,040 | 19% |
| Idle + 500 demo jobs | ~96,540 | 19% |
| Idle + 500 jobs + 20 admin-hours | ~104,940 | 21% |
