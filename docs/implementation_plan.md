# Production-Grade Task Processing System (BullMQ + Redis)

## Architectural Overview

This system implements an asynchronous background task processing pipeline for Node.js using TypeScript, BullMQ, Redis, Express, Pino, Zod, and SQLite.

### Directory Structure

```text
task-queue-system/
├── .github/
│   └── workflows/
│       └── ci.yml
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .env.example
├── README.md
├── docs/
│   ├── implementation_plan.md
│   ├── architecture.md
│   ├── design_decisions.md
│   ├── deployment.md
│   └── troubleshooting.md
├── src/
│   ├── index.ts
│   ├── config/
│   │   ├── environment.ts
│   │   └── redis.connection.ts
│   ├── queue/
│   │   ├── queue.ts
│   │   ├── producer.ts
│   │   └── dlq.ts
│   ├── processors/
│   │   ├── registry.ts
│   │   ├── email.processor.ts
│   │   └── report.processor.ts
│   ├── workers/
│   │   └── task.worker.ts
│   ├── logging/
│   │   └── logger.ts
│   ├── metrics/
│   │   └── metrics.service.ts
│   ├── storage/
│   │   └── idempotency.db.ts
│   └── types/
│       └── job.types.ts
└── tests/
    ├── queue.spec.ts
    └── worker.spec.ts
```

### Key Technical Specs

1. **BullMQ Retention & Retries:** `removeOnComplete: 1000`, `removeOnFail: 5000`, 3 retries with exponential backoff.
2. **Worker Concurrency & Rate Limit:** `concurrency: 5`, max 100 jobs/min.
3. **Idempotency Strategy:** Primary datastore check against SQLite (`idempotency_records` table) blocks duplicate side-effects even across Redis flushes or job retries.
4. **Dead Letter Queue (DLQ):** Failed jobs exhausting max retries are automatically captured in `dlq-task-queue`.
5. **Observability:** Prometheus metrics at `/metrics`, behind admin authentication outside local development, and the Bull Board UI at `/admin/queues`, which is public and read-only in every environment — all mutating methods are refused with `405`, and its polled data route is served from a snapshot cache so an always-on public dashboard stays within a free Redis tier's command budget. Plus structured Pino logging with secret redaction.
