# Production Deployment & Operations Guide

This guide covers environment configuration, Docker container management, scaling strategies, health monitoring, and production deployment considerations for the **Production-Grade Task Processing System**.

---

## 1. Environment Configuration

Copy the example environment file and customize values for your deployment environment:

```bash
cp .env.example .env
```

### Complete Environment Variables Reference

| Variable | Default Value | Required | Description |
| :--- | :--- | :---: | :--- |
| `NODE_ENV` | `development` | Yes | Environment mode (`development`, `production`, `test`) |
| `PORT` | `3000` | Yes | Port for Express HTTP server, Bull Board, and `/metrics` |
| `LOG_LEVEL` | `info` | No | Pino logging verbosity (`trace`, `debug`, `info`, `warn`, `error`) |
| `REDIS_HOST` | `localhost` | Yes | Redis server hostname or container service name |
| `REDIS_PORT` | `6379` | Yes | Redis server port |
| `REDIS_PASSWORD` | *Empty* | No | Redis authentication password (recommended for production) |
| `WORKER_CONCURRENCY` | `5` | No | Number of concurrent jobs processed per worker instance |
| `RATE_LIMIT_MAX` | `100` | No | Maximum jobs processed within rate limit window |
| `RATE_LIMIT_DURATION_MS` | `60000` | No | Duration window in milliseconds for rate limiting |
| `SQLITE_DB_PATH` | `./data/idempotency.db` | No | File path for primary SQLite idempotency database |

---

## 2. Running with Docker Compose

The included `docker-compose.yml` provisions a production-configured Redis 7 instance.

### Redis Configuration Specs
* Image: `redis:7-alpine`
* Command: `redis-server --maxmemory 256mb --maxmemory-policy noeviction --save 60 1`
* Persistence: Mounted volume (`redis_data`) ensuring queue state is saved to disk every 60 seconds if changes occur.
* Memory Policy: `noeviction` ensures Redis rejects new writes rather than silently evicting queue jobs or keys when memory limits are reached.

### Docker Operation Commands

```bash
# 1. Start Redis in background
docker compose up -d

# 2. View container status and healthcheck
docker compose ps

# 3. View Redis logs
docker compose logs -f redis

# 4. Stop Redis container
docker compose down
```

---

## 3. Application Lifecycle Management

### Local Development Mode
Starts the application using `tsx watch` for auto-reloading upon source code edits:
```bash
npm run dev
```

### Production Build & Execution
```bash
# 1. Typecheck source files
npm run typecheck

# 2. Run automated test suite
npm test

# 3. Build JavaScript bundle to dist/
npm run build

# 4. Start production server
npm start
```

---

## 4. Production Health Checks & Kubernetes Probes

The Express server exposes `/health` specifically designed for Kubernetes Liveness / Readiness probes and cloud load balancer health checks.

### Liveness Probe
Ensures the HTTP container process is responsive.
```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 15
```

### Readiness Probe
Verifies that connections to **Redis** and **SQLite** are healthy before routing traffic.
```yaml
readinessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10
```

### Sample `/health` Response (`200 OK`)
```json
{
  "status": "HEALTHY",
  "timestamp": "2026-07-26T18:15:00.000Z",
  "services": {
    "redis": "UP",
    "sqlite": "UP",
    "worker": "UP"
  }
}
```

---

## 5. Scaling Worker Instances

### Horizontal Scaling
To scale task processing throughput horizontally:
1. Deploy multiple instances of the Node.js application container behind a load balancer or as multiple Kubernetes Pods.
2. BullMQ uses Redis atomic locking (`BRPOPLPUSH` / Lua scripts) to ensure jobs are distributed across worker instances without duplicate delivery.

### Vertical Scaling
Tweak `WORKER_CONCURRENCY` in `.env`:
* CPU-bound tasks: Set `WORKER_CONCURRENCY` equal to available CPU cores.
* I/O-bound tasks (network requests, DB queries): Increase `WORKER_CONCURRENCY` to `10` or `20`.
