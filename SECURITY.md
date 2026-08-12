# Security Policy

## Reporting a Vulnerability

Please report security issues privately rather than opening a public issue.
Contact the maintainer through the address listed on the repository profile and
allow a reasonable window for a fix before any public disclosure.

---

## Threat Model

This service is a publicly reachable HTTP API that accepts job submissions and
writes them to a managed Redis instance on a metered free tier. The dominant risks
are therefore **resource abuse** and **unauthorized administrative access**, not
data theft: the system stores no personal data beyond the job payloads a caller
supplies, and holds no user accounts or sessions.

Two consequences follow, and they shape every control below:

1. Redis command consumption is a security-relevant budget. An attacker who can
   cheaply cause Redis work can exhaust a monthly quota, take the demo offline, and
   create financial exposure on a paid plan.
2. Any unauthenticated endpoint that touches Redis is an amplification primitive
   and must be either authenticated or rate limited.

---

## Controls

### Authentication & Authorization

| Surface | Control |
|---|---|
| `/admin/queues` and all nested routes | Public by design, but **read-only**: every non-`GET` method is refused with `405` before reaching Bull Board, and cost is bounded by a server-side snapshot cache |
| `/admin/queues/api/redis/stats` | Blocked outright. It returns raw Redis `INFO` (server version, memory layout, client list), which is infrastructure detail with no place on a public page |
| `/metrics` | HTTP Basic auth in every environment except local development |
| `/health` | Unauthenticated by design, so external uptime monitors can reach it. Performs no Redis command on the normal path |
| `POST /api/jobs/*` | Unauthenticated by design (public demo), constrained by rate limits, strict validation, and a queue-depth ceiling |

Credentials come from `BULLBOARD_USER` and `BULLBOARD_PASSWORD` and now guard
`/metrics` only. If either is unset, `/metrics` **fails closed** and refuses all
requests rather than serving without protection.

### Why the dashboard is public

The dashboard is the artifact being demonstrated. Putting it behind a login defeats
its purpose, so the boundary was moved from *who may look* to *what may be done*.

This is a deliberate reversal of an earlier revision, which put the dashboard behind
Basic auth. Authentication was solving the wrong problem: it made the dashboard
unusable as a demo while leaving the actual risk — that the mutating routes exist at
all — dependent on the credential never leaking.

Two independent controls replace it, because an open dashboard carries two unrelated
risks:

**Mutation.** `readOnlyMode: true` on the queue adapters is *not* a security control.
It sets a flag the bundled UI reads to hide destructive buttons, while
`POST /api/queues/:name/add`, `PUT .../obliterate`, `PUT .../empty`,
`PUT .../pause`, and `PUT .../:jobId/retry` all remain mounted and reachable by hand.
`dashboardReadOnlyGuard` refuses non-`GET` methods outright, which is what actually
prevents an anonymous drain or obliterate. It refuses them unconditionally — supplying
valid admin credentials does not unlock them, because read-only is a property of the
deployment rather than of the caller.

**Cost.** Bull Board's UI polls a single route, `GET /api/queues`, at roughly 8-10
Redis commands per poll. Uncached at the stock 5s interval, one open tab costs about
5,000 commands/hour, which is what exhausted a previous 500K/month allowance in three
days. `dashboardSnapshotCache` answers that route from memory, so spend is decoupled
from viewer count and poll rate. Freshness is preserved by invalidating on real events
— a job dispatched, completed, or failed — rather than by polling on a timer.

Comparison uses SHA-256 digests fed to `crypto.timingSafeEqual`, so neither the
username nor the password can be recovered by measuring response timing, and a
length mismatch cannot throw a distinguishable error.

### Input Validation

All job payloads are validated by strict Zod schemas. Unknown fields are
**rejected with HTTP 400**, not silently stripped, so a caller relying on a removed
field gets an explicit error instead of a job that quietly behaves differently.
String fields are length-bounded and request bodies are capped at `JSON_BODY_LIMIT`.

### No Artificial Failure Controls

This system processes real work. There is no request field, header, environment
variable, or admin control that forces a job to fail or to sleep.

An earlier revision accepted a `simulateFailure` boolean on the public API. Because
that flag drove three retry attempts plus a dead-letter write, a single
unauthenticated HTTP request amplified into roughly 10-14 Redis commands, and a
companion `delayMs` field could hold worker slots open. Both were removed rather
than gated behind an admin credential, because a real queue should demonstrate its
retry and DLQ behavior through real failures.

The public retry demonstration is the `WEBHOOK_DELIVERY` job type, which fails for a
real reason. Its processor issues a genuine HTTP request; the `DEMO_UNAVAILABLE`
destination resolves to a loopback path that is deliberately not served, so the
request returns a real `404`. The processor contains no branch that decides to fail —
it reports what the network returned. Retry, backoff, and DLQ routing are BullMQ's,
unmodified.

That job type is also SSRF-free by construction rather than by filtering. Callers
select a destination from an enum and the service maps the name to an address
internally, so no caller-supplied value ever reaches the HTTP client. A payload
carrying `targetUrl` is rejected with `400` like any other unknown field
(`tests/webhook.spec.ts`).

Retries, exponential backoff, and DLQ routing are exercised in the test suite by
injecting genuine dependency errors with mocks (`tests/worker.spec.ts`). A
regression test asserts that public payloads containing `simulateFailure` are
rejected as invalid input.

### Rate Limiting & Resource Ceilings

- **Per-IP limiter** on job submission (`HTTP_RATE_LIMIT_MAX_PER_IP` per window).
- **Global limiter** bounding total submissions from all clients per window, so a
  distributed burst is capped in aggregate.
- **Queue-depth ceiling** (`MAX_QUEUE_DEPTH`) rejecting submissions with `429` once
  pending work exceeds the limit.
- **Worker-side BullMQ limiter** capping processing throughput.

Both HTTP limiters use an in-memory store. This is deliberate: a Redis-backed
limiter would spend Redis commands on every request including the ones it rejects,
which would undermine the budget it exists to protect. A rejected request costs
**zero** Redis commands.

> Single-instance assumption: in-memory limiter state is per process. If the
> service is scaled beyond one instance, each instance enforces its own budget and
> the effective ceiling multiplies by the instance count.

The queue-depth read is demand-driven and memoized for a short TTL. There is
intentionally **no background timer polling Redis**; a 10-second depth poll would
cost roughly 8,640 Redis commands/day (~259K/month) purely to observe an idle queue.

### Transport & Headers

- `helmet` sets baseline security headers; `x-powered-by` is disabled.
- CORS uses an **explicit allowlist** (`CORS_ALLOWED_ORIGINS`). Wildcards are
  stripped during parsing, so `*` cannot be configured even accidentally. Requests
  without an `Origin` header pass through untouched, since CORS is browser-enforced
  and is not a substitute for authentication.
- Express `trust proxy` is set to a specific hop count rather than `true`, so a
  client cannot spoof `X-Forwarded-For` to evade per-IP limits.

### Secret Handling

- `REDIS_URL` is the sole Redis connection variable and is never logged.
- URL parse failures are reported **without** attaching the original error, because
  both `new URL()` and ioredis embed the full connection string (including the
  password) in their error messages. This was a real leak in an earlier revision.
- Pino is configured with `redact` paths covering authorization headers, passwords,
  and connection URLs, plus a formatter that scrubs credential-bearing URLs out of
  free-text message fields.
- Client-facing `500` responses carry a generic message; internal error text and
  stack traces stay in server-side logs.

### Failure Behavior

- Producer connections use `enableOfflineQueue: false`, so an enqueue during a Redis
  outage fails fast with `503` instead of buffering commands indefinitely and
  stalling the request.
- Worker connections keep the offline queue enabled, which is required for the
  blocking connection to survive Upstash's idle-socket resets mid-job.
- Reconnect backoff is bounded and logged sparsely to avoid a hot retry loop.

### Data Retention

Completed and failed jobs are trimmed by both count and age. DLQ entries are capped
at 1,000 entries / 30 days; previously they were retained indefinitely, allowing
unbounded Redis storage growth.

---

## Operational Guidance

- Never commit a real `.env`. Only `.env.example` is tracked, and it contains
  placeholders only.
- Rotate `BULLBOARD_PASSWORD` if it is ever entered into a shared browser or logged.
- The `/admin/queues` URL is public and safe to share. If you ever need to make it
  writable for real operations, do not simply remove `dashboardReadOnlyGuard` — put
  the write surface behind `requireAdminAuth` on a separate mount, so the public
  read path stays read-only.
- Watch `task_queue_dashboard_snapshot_total{source="redis"}` on `/metrics`. A
  rising ratio of `redis` to `cache` means snapshots are being invalidated more
  often than expected and is the first thing to check if the Upstash command
  counter climbs faster than projected.
- Do not raise `WORKER_DRAIN_DELAY_SECONDS` or `WORKER_STALLED_INTERVAL_MS` without
  reading `docs/security-remediation.md`; these values bound Redis consumption.
