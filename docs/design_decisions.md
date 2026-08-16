# Design Decisions, Engineering Tradeoffs & Interview FAQs

This document details core architectural choices, technology comparisons, and technical responses to common senior engineering interview questions regarding this system.

---

## 1. Technology Comparisons & Engineering Tradeoffs

```text
┌─────────────────────────┬──────────────────────────┬──────────────────────────┬──────────────────────────┐
│ Dimension               │ BullMQ + Redis           │ RabbitMQ                 │ Apache Kafka             │
├─────────────────────────┼──────────────────────────┼──────────────────────────┼──────────────────────────┤
│ Primary Focus           │ Node.js Task Queues      │ General AMQP Messaging   │ Log Stream Processing    │
│ TypeScript Integration  │ Native / First-Class     │ Via amqplib (Community)  │ Via kafkajs (Community)  │
│ Built-in Retries        │ Exponential / Custom     │ Dead Letter Exchange     │ Manual Topic Routing     │
│ Rate Limiting           │ Native Worker Limiter    │ Plugin Required          │ Application Layer        │
│ Operational Overhead    │ Low (Single Redis)       │ Medium (Erlang Cluster)  │ High (ZooKeeper/KRaft)   │
└─────────────────────────┴──────────────────────────┴──────────────────────────┴──────────────────────────┘
```

### BullMQ + Redis Rationale
* **Tight Node.js Event-Loop Integration:** BullMQ leverages Redis Lua scripts to execute atomic queue state transitions (`waiting` -> `active` -> `completed` / `failed`) without blocking the Node.js event loop.
* **Native Job Scheduling & Delayed Execution:** BullMQ supports delayed jobs (`opts.delay`), rate limiting (`limiter: { max, duration }`), and automatic retention policies (`removeOnComplete`, `removeOnFail`) directly out of the box.
* **Developer Velocity & Lightweight Footprint:** Redis runs effortlessly in local development and test environments via a single lightweight Docker container (`redis:7-alpine`), requiring < 20MB of RAM compared to multi-gigabyte Java/Scala Kafka clusters.

---

## 2. Idempotency Architecture: Hybrid Primary Datastore (SQLite) vs. Pure Redis

```text
               ┌─────────────────────────────────────────────────────────┐
               │              Incoming Job with idempotencyKey           │
               └────────────────────────────┬────────────────────────────┘
                                            │
                                            ▼
                      ┌───────────────────────────────────────────┐
                      │   SQLite Primary Datastore Check          │
                      │   (SELECT * FROM idempotency_records)     │
                      └─────────────────────┬─────────────────────┘
                                            │
                     ┌──────────────────────┴──────────────────────┐
                     │                                             │
                     ▼                                             ▼
          [Record Exists: COMPLETED]                    [Record Does Not Exist]
                     │                                             │
                     ▼                                             ▼
          Bypass Business Logic                         Execute Business Logic
          Return Cached Result (isDuplicate: true)      Record Success in SQLite
```

### Why a Primary Datastore for Idempotency?
Queue systems guarantee **at-least-once delivery**. A job may be re-delivered if:
1. A worker crashes mid-execution.
2. A network timeout delays job completion acknowledgment to Redis.
3. An operator manually retries a job.

Relying solely on Redis for idempotency key storage is vulnerable: if Redis memory fills up or Redis restarts, transient idempotency keys may be evicted, exposing downstream systems to duplicate side-effects.

By storing idempotency records in a durable primary database (`idempotency.db`), side-effect deduplication remains guaranteed even across complete Redis flush operations.

---

## 3. Senior Engineering Interview Discussion FAQs

### Q1: Why BullMQ instead of RabbitMQ or Kafka?
* **Answer:** BullMQ provides first-class TypeScript types, native delayed scheduling, built-in rate limiting, and exponential retries out of the box. RabbitMQ or Kafka would introduce unnecessary operational overhead (Erlang or JVM clusters) for a Node.js background task worker system where log streaming or complex AMQP topic exchanges are not required.

### Q2: Why SQLite instead of PostgreSQL?
* **Answer:** SQLite serves as a fast, zero-dependency stand-in for a primary relational database to prove durable side-effect deduplication (`idempotencyKey`) without requiring extra database container setup during local development and CI runs. In a production multi-node system, SQLite maps 1-to-1 with PostgreSQL using `ON CONFLICT` or `SELECT ... FOR UPDATE`.

### Q3: Why check idempotency *before* processing?
* **Answer:** Checking idempotency prior to executing side-effects prevents executing non-idempotent operations (such as charging a payment API or sending a customer email) more than once, even when BullMQ re-delivers a job due to network partitions or worker crashes.

### Q4: Why use stand-in processors (`email.processor.ts`, `report.processor.ts`)?
* **Answer:** The processors perform the full real job lifecycle—validation, idempotency check, side-effect, durable success record—against a stand-in side-effect rather than a live email/reporting vendor, so the queue mechanics can be demonstrated without third-party credentials. They contain **no** artificial failure or delay switches: earlier revisions accepted `simulateFailure` and `delayMs` as API fields, which let any unauthenticated caller force three retry attempts plus a DLQ write from one HTTP request (and, via `delayMs`, hold worker slots open). Both fields were removed. Retry, backoff, and DLQ behavior is verified in the test suite by injecting genuine dependency errors with mocks.

### Q4b: If there is no failure switch, how does the public demo show a retry?
* **Answer:** Through a failure that is real. The `WEBHOOK_DELIVERY` job type performs a genuine HTTP `POST`, and the `DEMO_UNAVAILABLE` destination resolves to a loopback path the service deliberately does not serve. The request really is issued and really returns `404`; the processor has no branch that chooses to fail, it only reports what the network returned. Everything downstream — 3 attempts, exponential backoff, DLQ routing into `dlq-task-queue` — is BullMQ's own machinery, unmodified and visible in the public dashboard.
* **Why not let the caller pass a URL?** That would be an SSRF hole on an unauthenticated endpoint: a caller could aim the worker at cloud metadata endpoints or internal services. Callers pick a destination from an enum instead, and the mapping to a real address happens server-side, so no caller-supplied value ever reaches the HTTP client. The defence is that no URL-shaped input exists, not that one is filtered.
* **Why loopback rather than a public "always fails" service?** The deployment has to keep working unattended. Depending on a third-party endpoint would make the demo's correctness contingent on someone else's uptime.

### Q4c: The queue dashboard is public with no login. Why is that not reckless?
* **Answer:** Because the boundary was moved from *who may look* to *what may be done*. An earlier revision put Bull Board behind HTTP Basic auth, which made the demo unusable for its actual purpose — being looked at — while leaving the real risk intact: the mutating routes still existed, and safety depended on a shared credential never leaking.

  An open dashboard carries two unrelated risks, so it takes two independent controls:

  **Mutation.** `readOnlyMode: true` on the adapters is not a security control; it is a UI flag. `POST /api/queues/:name/add`, `PUT .../obliterate`, `PUT .../empty` and the rest stay mounted and reachable with `curl`. A middleware refuses every non-`GET` method with `405` before the request reaches Bull Board, which removes the entire mutation surface. It refuses them unconditionally — valid admin credentials do not unlock them — because read-only is a property of the deployment, not of the caller.

  **Cost.** This is the one that actually caused an outage. Bull Board's UI polls `GET /api/queues` at roughly 8-10 Redis commands per poll. At the stock 5-second interval that is ~5,000 commands/hour for a single open tab, and one forgotten tab exhausted a 500K/month Upstash allowance in three days.

* **Why caching rather than a slower poll interval?** Slowing the poll trades responsiveness for cost and still scales linearly with the number of viewers — ten tabs cost ten times as much. A server-side snapshot cache decouples cost from both poll rate and viewer count: ten viewers cost exactly what one costs, and the UI is free to poll every 10 seconds because polls are answered from memory.
* **Isn't cached data stale data?** Not in the way that matters. The TTL is an idle backstop, not the refresh rate. The snapshot is invalidated the instant queue state actually changes — a job dispatched, completed, or failed — so the next poll after any real event goes to Redis and returns live data. While the queue is idle nothing is changing, so serving a cached snapshot is not a stale answer, it is the correct answer obtained for free. A visitor who dispatches a job sees it appear on the next poll.
* **What does it cost in practice?** One refresh costs a measured 26 Redis commands across the two queues; 20 repeated polls of the same view cost zero. The worst case is bounded by the backstop rather than by traffic: 96 refreshes/day (~2,500 commands/day, ~75,000/month) even with a tab left open permanently, against ~13.5M/month for the uncached equivalent. Measuring that 26 rather than assuming ~10 is what prompted raising the backstop from 5 to 15 minutes; at 5 minutes a single forgotten tab would have cost ~225,000/month.
* **Can a visitor just bypass the cache?** They could, and that was a real defect rather than a hypothetical. The cache originally keyed on the full request URL while deciding cacheability from the path, so appending a parameter Bull Board ignores — `?junk=1` — produced a miss and a full Redis rebuild every time: a measured 520 commands for 20 requests, versus 0 for 20 honest polls. Requests are now reduced to the four parameters Bull Board actually reads, each validated, so unknown or out-of-range values collapse onto the default view. A global ceiling on rebuilds per minute bounds what is left, and past that ceiling the last snapshot for that view is served stale rather than refreshed.
* **Why rewrite the request instead of just the cache key?** Because canonicalizing only the key is a cache-poisoning bug. If `?page=999` still reaches Bull Board, it builds a page-999 payload that gets stored under the canonical `page=1` key, and the next visitor asking for page 1 receives page 999's empty result for a full TTL — one crafted URL corrupting the board for everyone. The canonical values are written back onto `req.query`, so the cached body and the key it lives under always describe the same view. A cache key is a claim that two requests are equivalent, and that claim only holds if the *responses* are equivalent too.
* **How would you know if it regressed?** `/metrics` exposes `task_queue_dashboard_snapshot_total` labelled by `source`. The ratio of `redis` to `cache` is the health signal; a rising `redis` count means something is invalidating snapshots more often than expected, and any `stale` or `shed` count means the global refresh budget is being hit — which on this service means someone is hammering the board.

### Q5: What happens if Redis crashes?
* **Answer:** Docker Compose persistence saves Redis queue data to disk (`--save 60 1`). If Redis crashes, uncompleted jobs remain safely persisted on disk. Furthermore, because primary idempotency records reside in SQLite, processed jobs will never execute duplicate side-effects when Redis recovers.

### Q6: What happens if a worker crashes halfway through a job?
* **Answer:** BullMQ uses an active lock duration (30 seconds). If a worker process crashes, its lock expires, and BullMQ re-assigns the job to another worker instance. Upon redelivery, the new worker checks SQLite: if the side-effect completed before the crash, it skips execution; if not, it executes safely.

### Q7: Why do you expose `/metrics`?
* **Answer:** Prometheus scraping `/metrics` enables real-time alert triggers on queue depth spikes, processing latency degraded performance, and high job failure rates before users experience outages.

### Q8: How would this scale to multiple workers?
* **Answer:** Multiple Node.js worker instances can run in parallel across Kubernetes pods or servers connected to the same Redis cluster. BullMQ's atomic Redis Lua scripts automatically handle job distribution and lock contention across all worker nodes without double-assignment.

### Q9: What would you change for a large-scale production environment?
* **Answer:** 
  1. Replace SQLite with PostgreSQL or Amazon Aurora with connection pooling (e.g., PgBouncer).
  2. Provision a Redis Sentinel or AWS ElastiCache Redis cluster with automatic failover.
  3. Integrate OpenTelemetry distributed tracing with correlation IDs across HTTP endpoints and background workers.
