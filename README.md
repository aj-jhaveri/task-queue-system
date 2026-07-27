# Production-Grade Task Processing System

Asynchronous background task processing engine built with **Node.js**, **TypeScript**, **BullMQ**, **Redis**, **Express**, **Pino**, **Zod**, and **SQLite**.

---

## What It Is

A production-grade microservice template demonstrating robust background job queues, rate limiting, concurrency management, dead-letter queue (DLQ) routing, primary datastore idempotency, Prometheus metrics, and real-time dashboard observability.

## Why It Exists

Distributed backend systems require reliable execution of asynchronous side-effects (e.g., email notifications, heavy analytical report generation) isolated from client HTTP request loops. This project provides a battle-tested reference implementation addressing critical production concerns:
* **Durable Idempotency:** Blocking duplicate side-effects across Redis flushes or network retries.
* **Resilience:** Automatic retries with exponential backoff and automatic DLQ routing.
* **Observability:** Metrics scraping and interactive web UI for queue administration.

---

## What This Project Demonstrates

This project showcases production backend engineering practices including:

* **Asynchronous background processing**
* **Durable idempotency**
* **Runtime validation**
* **Worker concurrency**
* **Retry and exponential backoff**
* **Dead-letter queue handling**
* **Structured logging**
* **Operational metrics**
* **Health monitoring**
* **CI/CD automation**
* **Automated testing**

---

## Architecture

```text
Client
  │
  │  POST /api/jobs/report
  ▼
Express API (Zod Validation)
  │
  │  dispatchReportJob()
  ▼
BullMQ Queue ──► Redis Store
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

### SQLite as Primary Datastore Stand-In
* Used **SQLite** to demonstrate durable side-effect deduplication (`idempotencyKey`) across Redis restarts without requiring a full PostgreSQL deployment.

---

## Key Features

* **Concurrency & Rate Limiting:** 5 concurrent worker threads per instance, worker-level rate limiting (100 jobs/min).
* **Idempotent Side-Effects:** Primary datastore check prevents duplicate executions.
* **Dead Letter Queue (DLQ):** Automatic failover to `dlq-task-queue` on max retry exhaustion.
* **Observability:** Built-in Prometheus `/metrics` endpoint and Bull Board dashboard at `/admin/queues`.
* **Runtime Type Safety:** Strict Zod schema validation on input boundaries.

---

## Visual Previews & Output

### 1. Bull Board Dashboard (`/admin/queues`)
```text
┌─────────────────────────────────────────────────────────────────────────────────┐
│ Bull Board - Queue Management                                                   │
├─────────────────────────────────────────────────────────────────────────────────┤
│ Queue: task-processing-queue                                                    │
│ [Active: 0]  [Waiting: 0]  [Completed: 142]  [Failed: 0]  [Delayed: 0]           │
├─────────────────────────────────────────────────────────────────────────────────┤
│ Queue: dlq-task-queue                                                           │
│ [Active: 0]  [Waiting: 0]  [Completed: 0]    [Failed: 3]  [Delayed: 0]           │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 2. Prometheus Metrics Endpoint (`/metrics`)
```text
# HELP task_queue_jobs_processed_total Total number of task queue jobs processed
# TYPE task_queue_jobs_processed_total counter
task_queue_jobs_processed_total{job_type="EMAIL_NOTIFICATION",status="success"} 89
task_queue_jobs_processed_total{job_type="REPORT_GENERATION",status="success"} 53

# HELP task_queue_processing_duration_seconds Task processing duration in seconds
# TYPE task_queue_processing_duration_seconds histogram
task_queue_processing_duration_seconds_bucket{job_type="EMAIL_NOTIFICATION",le="0.1"} 89
```

### 3. Structured Pino Logger Output
```json
{"level":30,"time":1774569600000,"pid":1234,"env":"development","jobId":"email_key_101","idempotencyKey":"key_101","to":"user@example.com","attempt":0,"msg":"Processing Email Job"}
{"level":30,"time":1774569600050,"pid":1234,"env":"development","jobId":"email_key_101","idempotencyKey":"key_101","durationMs":48,"messageId":"msg_1774569600_a8b9c0","msg":"Email job successfully executed"}
```

### 4. Duplicate Job Idempotency Skip Log
```json
{"level":40,"time":1774569605000,"pid":1234,"env":"development","jobId":"email_key_101","idempotencyKey":"key_101","msg":"Duplicate job execution blocked by SQLite primary datastore idempotency check"}
```

### 5. DLQ Escalation Log
```json
{"level":50,"time":1774569610000,"pid":1234,"env":"development","dlqJobId":"dlq_report_key_500_1774569610","originalJobId":"report_key_500","jobName":"REPORT_GENERATION","reason":"Simulated Report Processor failure (attempt 3)","msg":"Job exhausted all retry attempts and moved to Dead Letter Queue (DLQ)"}
```

---

## Quick Start

### 1. Start Redis
```bash
docker compose up -d
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Run Development Server
```bash
npm run dev
```

### 4. Run Tests
```bash
npm test
```

### 5. Typecheck & Build
```bash
npm run typecheck
npm run build
```

---

## REST API Usage

### Dispatch Email Job
```bash
curl -X POST http://localhost:3000/api/jobs/email \
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
curl -X POST http://localhost:3000/api/jobs/report \
  -H "Content-Type: application/json" \
  -d '{
    "reportType": "FINANCIAL",
    "userEmail": "finance@company.com",
    "filters": { "quarter": "Q3", "year": 2026 },
    "idempotencyKey": "report_demo_001",
    "simulateFailure": false
  }'
```

---

## Documentation Links

* [System Architecture (`docs/architecture.md`)](docs/architecture.md)
* [Design Decisions & Engineering Tradeoffs (`docs/design_decisions.md`)](docs/design_decisions.md)
* [Deployment & Operations (`docs/deployment.md`)](docs/deployment.md)
* [Troubleshooting & DLQ Guide (`docs/troubleshooting.md`)](docs/troubleshooting.md)
* [Implementation Plan (`docs/implementation_plan.md`)](docs/implementation_plan.md)
