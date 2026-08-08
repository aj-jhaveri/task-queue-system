# Production-Grade Task Processing System

**Live demo:** [slakedesign.com/demo/queue](https://slakedesign.com/demo/queue) · **Bull Board:** [slake-task-queue.onrender.com/admin/queues](https://slake-task-queue.onrender.com/admin/queues)

Asynchronous background task processing microservice built with **Node.js**, **TypeScript**, **BullMQ**, **Redis**, **Express**, **Pino**, **Zod**, and **SQLite** — deployed on **Render** with **Upstash Cloud Redis**.

---

## What It Is

A production-grade microservice demonstrating robust background job queues, rate limiting, concurrency management, dead-letter queue (DLQ) routing, SQLite idempotency, Prometheus metrics, and real-time Bull Board observability.

**Production deployment:** The system runs continuously on Render with Upstash Cloud Redis (TLS, IPv4). UptimeRobot pings `/health` every 5 minutes — no cold starts. Dispatch real jobs at [slakedesign.com/demo/queue](https://slakedesign.com/demo/queue).

## Why It Exists

Distributed backend systems require reliable execution of asynchronous side-effects (e.g., email notifications, heavy analytical report generation) isolated from client HTTP request loops. This project provides a battle-tested reference implementation addressing critical production concerns:
* **Durable Idempotency:** Blocking duplicate side-effects across Redis flushes or network retries.
* **Resilience:** Automatic retries with exponential backoff and automatic DLQ routing.
* **Observability:** Metrics scraping and interactive web UI for queue administration.

---

## What This Project Demonstrates

* **Asynchronous background processing**
* **Durable idempotency** (SQLite deduplication store)
* **Runtime validation** (Zod schemas on all input boundaries)
* **Worker concurrency** (5 concurrent workers, 100 jobs/min rate limit)
* **Retry and exponential backoff**
* **Dead-letter queue handling**
* **Structured logging** (Pino JSON)
* **Operational metrics** (Prometheus `/metrics`)
* **Health monitoring** (`/health` with Redis + SQLite status)
* **CI/CD automation** (GitHub Actions)
* **Automated testing** (Vitest)
* **Cloud Redis deployment** (Upstash + ioredis TLS, IPv4-forced for Node 24)

---

## Architecture

```text
Client
  │
  │  POST /api/jobs/email  (or /api/jobs/report)
  ▼
Express API (Zod Validation)
  │
  │  dispatchEmailJob() / dispatchReportJob()
  ▼
BullMQ Queue ──► Upstash Cloud Redis (rediss://, TLS)
                   │
                   ▼
               Task Worker (Concurrency: 5, Rate Limit: 100/min)
                   │
                   ▼
            Processor Registry
                   │
                   ├──► SQLite Idempotency Check
                   │      ├── (If Processed) ──► Return Cached Result
                   │      └── (If New) ────────► Execute Mock Business Logic
                   ▼
               Completed / (Failure ──► Exponential Retries ──► DLQ)
```

---

## Engineering Tradeoffs

### BullMQ + Redis vs. RabbitMQ / Kafka
* **Selected BullMQ** for native TypeScript typing, non-blocking Node.js integration, built-in rate-limiting, exponential retries, and zero-overhead local Docker development.

### Upstash Cloud Redis vs. Self-Hosted
* **Upstash** provides a serverless Redis with REST and TCP endpoints, free tier, and global availability — ideal for a portfolio deployment that stays warm with no ops overhead. TCP connection with ioredis requires explicit `host`/`port`/`password` parsing from the `REDIS_URL` and `family: 4` (IPv4) for Node 24 compatibility.

### SQLite as Idempotency Store
* Used **SQLite** to demonstrate durable side-effect deduplication (`idempotencyKey`) across Redis restarts without requiring a full PostgreSQL deployment.

---

## Key Features

* **Concurrency & Rate Limiting:** 5 concurrent worker threads per instance, worker-level rate limiting (100 jobs/min).
* **Idempotent Side-Effects:** SQLite primary datastore check prevents duplicate executions.
* **Dead Letter Queue (DLQ):** Automatic failover to `dlq-task-queue` on max retry exhaustion.
* **Observability:** Built-in Prometheus `/metrics` endpoint and Bull Board dashboard at `/admin/queues`.
* **Runtime Type Safety:** Strict Zod schema validation on input boundaries.
* **Cloud Deployment:** Runs on Render with Upstash Cloud Redis. Zero cold starts via UptimeRobot keepalive.

---

## Visual Previews & Observability

### 1. Grafana Dashboard (`http://localhost:3001`)
Pre-configured, auto-provisioned Grafana dashboard (*Login: `admin` / `admin`*):

![Task Queue System Grafana Dashboard](docs/images/grafana_dashboard.png)

* **Live Queue Depth**: Active, waiting, completed, and failed job counts over time.
* **Processing Latency**: Real-time histograms for job execution durations.
* **System Metrics**: Node.js event loop lag and RAM memory usage.

### 2. Bull Board Dashboard

**Live:** [slake-task-queue.onrender.com/admin/queues](https://slake-task-queue.onrender.com/admin/queues)
**Local:** `http://localhost:3000/admin/queues`

```text
┌─────────────────────────────────────────────────────────────────────────────────┐
│ Bull Board - Queue Management                                                   │
├─────────────────────────────────────────────────────────────────────────────────┤
│ Queue: task-processing-queue                                                    │
│ [Active: 0]  [Waiting: 0]  [Completed: 12]  [Failed: 0]  [Delayed: 0]          │
├─────────────────────────────────────────────────────────────────────────────────┤
│ Queue: dlq-task-queue                                                           │
│ [Active: 0]  [Waiting: 0]  [Completed: 0]   [Failed: 3]  [Delayed: 0]          │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 3. Prometheus Metrics (`http://localhost:3000/metrics`)
```text
# HELP task_queue_jobs_processed_total Total number of task queue jobs processed
# TYPE task_queue_jobs_processed_total counter
task_queue_jobs_processed_total{job_type="EMAIL_NOTIFICATION",status="success"} 89
task_queue_jobs_processed_total{job_type="REPORT_GENERATION",status="success"} 53

# HELP task_queue_processing_duration_seconds Task processing duration in seconds
# TYPE task_queue_processing_duration_seconds histogram
task_queue_processing_duration_seconds_bucket{job_type="EMAIL_NOTIFICATION",le="0.1"} 89
```

### 4. Structured Pino Logger Output
```json
{"level":30,"time":1774569600000,"pid":1234,"env":"development","jobId":"email_key_101","idempotencyKey":"key_101","to":"user@example.com","attempt":0,"msg":"Processing Email Job"}
{"level":30,"time":1774569600050,"pid":1234,"env":"development","jobId":"email_key_101","idempotencyKey":"key_101","durationMs":48,"messageId":"msg_1774569600_a8b9c0","msg":"Email job successfully executed"}
```

### 5. Duplicate Job Idempotency Skip Log
```json
{"level":40,"time":1774569605000,"pid":1234,"env":"development","jobId":"email_key_101","idempotencyKey":"key_101","msg":"Duplicate job execution blocked by SQLite primary datastore idempotency check"}
```

### 6. DLQ Escalation Log
```json
{"level":50,"time":1774569610000,"pid":1234,"env":"development","dlqJobId":"dlq_report_key_500_1774569610","originalJobId":"report_key_500","jobName":"REPORT_GENERATION","reason":"Simulated Report Processor failure (attempt 3)","msg":"Job exhausted all retry attempts and moved to Dead Letter Queue (DLQ)"}
```

---

## Quick Start

### Option A: Try the Live Demo

Dispatch a real job at [slakedesign.com/demo/queue](https://slakedesign.com/demo/queue) or call the API directly:

```bash
# Dispatch an email job to the live production system
curl -X POST https://slake-task-queue.onrender.com/api/jobs/email \
  -H "Content-Type: application/json" \
  -d '{
    "to": "alice@example.com",
    "subject": "System Alert",
    "body": "Your task processing system is online.",
    "idempotencyKey": "email_demo_001"
  }'

# Check health
curl https://slake-task-queue.onrender.com/health
```

Then inspect the job in Bull Board: [slake-task-queue.onrender.com/admin/queues](https://slake-task-queue.onrender.com/admin/queues)

### Option B: Run Locally

#### 1. Start Redis
```bash
docker compose up -d
```

#### 2. Install Dependencies
```bash
npm install
```

#### 3. Run Development Server
```bash
npm run dev
```

#### 4. Interactive Terminal CLI Tester
In a separate terminal window:
```bash
npm run cli
```

#### 5. Run Automated Tests
```bash
npm test
```

#### 6. Postman API Collection
Import `task-queue-system.postman_collection.json` into **Postman** or **Bruno** to test all endpoints with 1 click.

#### 7. Typecheck & Build
```bash
npm run typecheck
npm run build
```

---

## REST API

### Dispatch Email Job
```bash
curl -X POST https://slake-task-queue.onrender.com/api/jobs/email \
  -H "Content-Type: application/json" \
  -d '{
    "to": "alice@example.com",
    "subject": "System Alert",
    "body": "Your task processing system is online.",
    "idempotencyKey": "email_demo_001"
  }'
```

### Dispatch Report Job (with failure simulation)
```bash
curl -X POST https://slake-task-queue.onrender.com/api/jobs/report \
  -H "Content-Type: application/json" \
  -d '{
    "reportType": "FINANCIAL",
    "userEmail": "finance@company.com",
    "filters": { "quarter": "Q3", "year": 2026 },
    "idempotencyKey": "report_demo_001",
    "simulateFailure": false
  }'
```

### Health Check
```bash
curl https://slake-task-queue.onrender.com/health
# → {"status":"HEALTHY","timestamp":"...","services":{"redis":"UP","sqlite":"UP","worker":"UP"}}
```

---

## Environment Variables (Render / Production)

| Variable | Description |
|---|---|
| `REDIS_URL` | Full Upstash Cloud Redis connection string (`rediss://...`) |
| `NODE_ENV` | Set to `production` |
| `PORT` | HTTP server port (Render sets this automatically) |

---

## Documentation Links

* [System Architecture (`docs/architecture.md`)](docs/architecture.md)
* [Design Decisions & Engineering Tradeoffs (`docs/design_decisions.md`)](docs/design_decisions.md)
* [Deployment & Operations (`docs/deployment.md`)](docs/deployment.md)
* [Troubleshooting & DLQ Guide (`docs/troubleshooting.md`)](docs/troubleshooting.md)
