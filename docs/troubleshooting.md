# Operational & Troubleshooting Playbook

This operational playbook provides step-by-step diagnostic workflows, failure recovery procedures, and troubleshooting steps for common failure modes in the **Task Processing System**.

---

## 1. Dead Letter Queue (DLQ) Management & Replay

When a job fails after exhausting all retry attempts (default: 3 attempts with exponential backoff), the worker automatically catches the failure and routes it to `dlq-task-queue`.

### DLQ Payload Schema
Failed jobs stored in `dlq-task-queue` contain the following structured JSON payload:
```json
{
  "originalJobId": "report_key_999",
  "jobName": "REPORT_GENERATION",
  "data": {
    "reportType": "FINANCIAL",
    "userEmail": "admin@company.com",
    "idempotencyKey": "key_999",
    "simulateFailure": true
  },
  "failedReason": "Simulated Report Processor failure (attempt 3)",
  "failedAt": "2026-07-26T18:15:00.000Z",
  "attemptsMade": 3,
  "stacktrace": [
    "Error: Simulated Report Processor failure...",
    "    at processReportJob (src/processors/report.processor.ts:28:11)"
  ]
}
```

### Inspecting & Retrying DLQ Jobs via Bull Board UI
1. Open `http://localhost:3000/admin/queues` in your browser.
2. Click on `dlq-task-queue`.
3. Review failed job data, stacktraces, and error reasons.
4. To retry a failed job after fixing underlying causes, click **Retry** on the target job card.

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
  2. Ensure mandatory payload fields (`to`, `subject`, `body`, `idempotencyKey` for email jobs; `reportType`, `userEmail`, `idempotencyKey` for report jobs) match the expected schema.

---

### Scenario E: SQLite Database Locking (`SQLITE_BUSY: database is locked`)
* **Symptom:** SQLite throws write lock contention errors under extreme concurrent throughput.
* **Root Cause:** SQLite default rollback journal mode blocks concurrent readers/writers.
* **Resolution Steps:**
  1. The system automatically initializes SQLite with `WAL` (Write-Ahead Logging) mode enabled for high concurrency.
  2. In high-scale production deployments with > 50 concurrent worker instances, migrate `idempotencyDb` to PostgreSQL or MySQL with connection pooling.
