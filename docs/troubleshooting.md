# Operational & Troubleshooting Playbook

This operational playbook provides step-by-step diagnostic workflows, failure recovery procedures, and troubleshooting steps for common failure modes in the **Task Processing System**.

---

## 1. Dead Letter Queue (DLQ) Management & Replay

When a job fails after exhausting all retry attempts (default: 3 attempts with exponential backoff), the worker automatically catches the failure and routes it to `dlq-task-queue`.

### DLQ Payload Schema
Failed jobs stored in `dlq-task-queue` contain the following structured JSON payload:
```json
{
  "originalJobId": "webhook_key_999",
  "jobName": "WEBHOOK_DELIVERY",
  "data": {
    "destination": "DEMO_UNAVAILABLE",
    "event": "order.created",
    "idempotencyKey": "key_999"
  },
  "failedReason": "Request failed with status 404",
  "failedAt": "2026-07-26T18:15:00.000Z",
  "attemptsMade": 3,
  "stacktrace": [
    "Error: Request failed with status 404",
    "    at processWebhookJob (src/processors/webhook.processor.ts:88:11)"
  ]
}
```

> Failures are always genuine. The system has no request field or admin control for
> forcing a job to fail; DLQ entries only ever represent real processor errors.
> Controlled failures for testing are injected inside the test suite via mocks
> (see `tests/worker.spec.ts`).

### Inspecting DLQ Jobs via Bull Board UI
1. Open `http://localhost:3000/admin/queues` (or the deployed dashboard) in your
   browser. No credentials are required in any environment.
2. Click on `dlq-task-queue`.
3. Review failed job data, stacktraces, and error reasons.

**Retrying is deliberately unavailable through the dashboard.** It is public and
read-only: `readOnlyMode` hides the retry control, and the middleware guard refuses
the underlying `PUT` with `405` regardless of the UI state. To requeue a job after
fixing the root cause, dispatch a fresh one through `POST /api/jobs/*` with a new
idempotency key, or operate on the queue directly with the CLI (`npm run cli`).

If you need a genuinely writable dashboard for operations, mount a second Bull
Board instance behind `requireAdminAuth` rather than removing the guard from the
public one — see `SECURITY.md`.

### Inspecting DLQ via Redis CLI
```bash
# Connect to Redis container shell
docker exec -it task_queue_redis redis-cli

# List all keys associated with DLQ
KEYS bull:dlq-task-queue:*

# Inspect active DLQ job count
LLEN bull:dlq-task-queue:wait
```

---

## 2. Common Failure Modes & Diagnostic Procedures

### Scenario A: `ECONNREFUSED 127.0.0.1:6379` / Redis Connection Errors
* **Symptom:** Logs show `Redis Connection Error` and worker retries connections indefinitely.
* **Root Cause:** Redis server is stopped or port 6379 is occupied by another process.
* **Resolution Steps:**
  1. Check if Redis container is running:
     ```bash
     docker compose ps
     ```
  2. If container is stopped, start it:
     ```bash
     docker compose up -d
     ```
  3. Verify port binding:
     ```bash
     nc -zv localhost 6379
     ```

---

### Scenario A2: Deployed service answers HTTP but reports `"redis":"DOWN"`

* **Symptom:** `GET /health` returns `503` with `{"services":{"redis":"DOWN","sqlite":"UP","worker":"UP"}}`, while `GET /` returns `200` normally. Job dispatch fails with `503`.
* **Diagnosis:** The process is alive and serving; only the Redis connection is failing. That narrows it to configuration or deploy state, not the application. Check the Upstash **command counter** first — if it reads `0`, nothing has ever connected to that database, which distinguishes a bad connection from an intermittent one.
* **Root causes, in order of likelihood:**

  1. **The deploy never landed.** A cancelled or failed deploy leaves the previous instance running with the *previous* environment. If `REDIS_URL` was updated after that instance started — or the old database it points at was deleted — the running process keeps trying to reach an address that no longer exists. In Render, check the service's deploy status: anything other than a green **Deployed** on the latest commit means the environment you think is live is not.
     *Fix:* trigger a fresh deploy. Changing an environment variable normally does this automatically, but only if the resulting deploy is allowed to finish.

  2. **`REDIS_URL` holds Upstash's REST URL instead of its TCP URL.** Upstash's console exposes both, and they are not interchangeable. The REST API tab gives `https://<host>.upstash.io` plus a *separate* bearer token; the Redis connect tab gives `redis://default:<password>@<host>.upstash.io:6379`. This service needs the second one. `getNormalizedRedisUrl()` rewrites `https://` to `rediss://`, so a REST URL parses and connects — but it carries no password, so it fails authentication and reports `DOWN` with no obvious clue.
     *Fix:* copy the TCP URL from the Redis connect tab. Strip any `redis-cli --tls -u` prefix; the variable takes only the URL itself. `redis://` is fine — TLS is applied automatically for `upstash.io` hosts.

  3. **`REDIS_URL` is unset or misspelled.** The config falls back to `REDIS_HOST`/`REDIS_PORT`, which default to `localhost:6379`. In a container that is connection-refused, presenting as the same `DOWN`.
     *Fix:* confirm the variable name exactly, then redeploy.

* **Verification:** after a successful deploy, `GET /health` returns `200` / `HEALTHY`, and the Upstash command counter begins climbing slowly (a few thousand per day at idle). A counter still pinned at `0` means the new configuration is still not live.

---

### Scenario B: High Queue Latency / Job Backlog Building Up
* **Symptom:** `task_queue_depth_jobs{state="waiting"}` increases while job completion rates lag behind.
* **Root Cause:** Ingestion rate exceeds worker throughput, or individual jobs are executing long blocking delays.
* **Resolution Steps:**
  1. Inspect metrics endpoint at `http://localhost:3000/metrics` for `task_queue_processing_duration_seconds`.
  2. Increase `WORKER_CONCURRENCY` in `.env` (e.g. from `5` to `15`).
  3. Deploy additional horizontal worker container instances.

---

### Scenario C: Stalled Job Warning (`job stalled ...`)
* **Symptom:** Worker logs report `job stalled more than maxStalledCount`.
* **Root Cause:** A worker process was killed abruptly (e.g., OOM killed or unhandled segfault) while processing an active job, leaving the job lock in Redis unreleased.
* **Resolution Steps:**
  1. BullMQ automatically detects stalled jobs when `lockDuration` expires (default: 30,000 ms) and re-assigns them to an active worker.
  2. Inspect memory usage on the host machine to ensure Node.js processes are not exceeding RAM limits.

---

### Scenario D: `ZodError: Invalid Payload Schema` (`400 Bad Request`)
* **Symptom:** REST API returns `400 Bad Request` with Zod validation details.
* **Root Cause:** Client submitted a job request missing required parameters or with invalid types (e.g. invalid email address format).
* **Resolution Steps:**
  1. Check the response body `details` array returned by the API.
  2. Ensure mandatory payload fields (`to`, `subject`, `body`, `idempotencyKey` for email jobs; `destination`, `event`, `idempotencyKey` for webhook jobs) match the expected schema.

---

### Scenario E: SQLite Database Locking (`SQLITE_BUSY: database is locked`)
* **Symptom:** SQLite throws write lock contention errors under extreme concurrent throughput.
* **Root Cause:** SQLite default rollback journal mode blocks concurrent readers/writers.
* **Resolution Steps:**
  1. The system automatically initializes SQLite with `WAL` (Write-Ahead Logging) mode enabled for high concurrency.
  2. In high-scale production deployments with > 50 concurrent worker instances, migrate `idempotencyDb` to PostgreSQL or MySQL with connection pooling.
