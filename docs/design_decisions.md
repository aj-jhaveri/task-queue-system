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
* **Native Job Scheduling & Delayed Execution:** BullMQ supports delayed jobs (`delayMs`), rate limiting (`limiter: { max, duration }`), and automatic retention policies (`removeOnComplete`, `removeOnFail`) directly out of the box.
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

### Q4: Why use mock processors (`email.processor.ts`, `report.processor.ts`)?
* **Answer:** Mock processors allow exact simulation of realistic production scenarios—such as network delays (`delayMs`) and intermittent third-party API outages (`simulateFailure: true`)—to verify that worker retries, rate-limiting, and DLQ escalation function predictably under stress.

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
