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
| `REDIS_URL` | *Empty* | No | Redis connection URL (`rediss://default:...@host:6379`) for cloud hosting |
| `REDIS_HOST` | `localhost` | Yes | Redis server hostname or container service name |
| `REDIS_PORT` | `6379` | Yes | Redis server port |
| `REDIS_PASSWORD` | *Empty* | No | Redis authentication password (recommended for production) |
| `BULLBOARD_USER` | *Empty* | No | Username for `/metrics` **only**. The queue dashboard is public and read-only and does not use it. `/metrics` fails closed if unset |
| `BULLBOARD_PASSWORD` | *Empty* | No | Password for `/metrics`. Never commit a real value |
| `DASHBOARD_SNAPSHOT_TTL_MS` | `300000` | No | Idle backstop for the dashboard snapshot cache. **Load-bearing for the Redis command budget.** Not the refresh rate — real events invalidate immediately |
| `DASHBOARD_POLL_INTERVAL_SECONDS` | `10` | No | Forced Bull Board UI poll interval. Safe to keep low because polls are served from the snapshot cache |
| `DASHBOARD_MAX_CACHE_ENTRIES` | `64` | No | Snapshot cache entry ceiling; bounds memory against a query-string key-space attack |
| `DASHBOARD_RATE_LIMIT_MAX_PER_IP` | `120` | No | Per-IP ceiling for the public dashboard, covering the uncached job-detail routes |
| `WEBHOOK_TIMEOUT_MS` | `5000` | No | Timeout for the webhook processor's real HTTP delivery |
| `CORS_ALLOWED_ORIGINS` | `https://slakedesign.com,https://www.slakedesign.com` | Yes (deployed) | Comma-separated browser origin allowlist. Wildcards are ignored |
| `WORKER_DRAIN_DELAY_SECONDS` | `60` | No | Idle long-poll seconds. **Load-bearing for the Redis command budget** |
| `WORKER_STALLED_INTERVAL_MS` | `300000` | No | Stalled-job check interval. **Load-bearing for the Redis command budget** |
| `WORKER_CONCURRENCY` | `5` | No | Number of concurrent jobs processed per worker instance |
| `RATE_LIMIT_MAX` | `100` | No | BullMQ worker-side processing limit within the window |
| `RATE_LIMIT_DURATION_MS` | `60000` | No | BullMQ worker-side limiter window in milliseconds |
| `HTTP_RATE_LIMIT_MAX_PER_IP` | `20` | No | HTTP job submissions allowed per client IP per window |
| `HTTP_RATE_LIMIT_MAX_GLOBAL` | `200` | No | HTTP job submissions allowed from all clients per window |
| `HTTP_RATE_LIMIT_WINDOW_MS` | `60000` | No | HTTP intake rate limit window |
| `MAX_QUEUE_DEPTH` | `1000` | No | Pending-job ceiling; submissions beyond it return `429` |
| `QUEUE_DEPTH_CACHE_TTL_MS` | `5000` | No | TTL for the on-demand queue-depth read |
| `JSON_BODY_LIMIT` | `16kb` | No | Maximum accepted request body size |
| `TRUST_PROXY_HOPS` | `1` | No | Proxy hops to trust for client IP resolution (Render uses 1) |
| `SQLITE_DB_PATH` | `./data/idempotency.db` | No | File path for primary SQLite idempotency database |

> `WORKER_DRAIN_DELAY_SECONDS` and `WORKER_STALLED_INTERVAL_MS` bound idle Redis
> consumption. BullMQ's defaults (5 / 30000) cost ~37,440 commands per idle day,
> which exceeds Upstash's free monthly allowance on its own. See
> [security-remediation.md](security-remediation.md) before changing them.

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

### Render Build & Start Commands

| Setting | Value |
| :--- | :--- |
| **Build Command** | `npm ci --include=dev && npm run build && npm prune --omit=dev` |
| **Start Command** | `npm start` |
| **Instances** | `1` |

All three parts of the build command are load-bearing, and the reason is that
Render compiles TypeScript on the server, in the same filesystem the application
then runs in.

**`--include=dev`** — `NODE_ENV=production` makes npm set `omit=dev`, which strips
the `devDependencies`. But `typescript` and the `@types/*` packages are exactly what
`tsc` needs to compile. Without this flag the build fails with dozens of
`TS2591: Cannot find name 'process'` and `TS7016: Could not find a declaration file`
errors. It is not obvious from the error output that the cause is an environment
variable rather than a missing dependency.

**`npm ci` rather than `npm install`** — this one is not stylistic. Render restores a
cached `node_modules` between deploys, and `npm install` leaves an already-present
package alone. `better-sqlite3` is a native module whose compiled binary is tied to a
Node major version (`NODE_MODULE_VERSION`), so a cached binary built under an earlier
Node will survive `npm install` and then fail to load at startup with
`ERR_DLOPEN_FAILED ... compiled against a different Node.js version`. The build
succeeds and the process crashes on boot, which is a confusing place to discover it.
`npm ci` deletes `node_modules` outright and installs from the lockfile, so a stale
native binary cannot persist across a Node version change.

**`npm prune --omit=dev`** — because build and runtime share a filesystem here,
installing dev dependencies would otherwise leave `typescript`, `vitest` and every
`@types` package in the running container. Pruning after the build removes them once
`dist/` exists: 152 packages ship instead of 202. Dev dependencies live only as long
as compilation.

Dropping `NODE_ENV=production` instead of adding these flags also produces a working
build, but it is the wrong trade: the variable is what keeps `pino-pretty` (a
devDependency) from being loaded by the logger and keeps production logs from being
tagged `development`.

The `deploy-parity` job in `.github/workflows/ci.yml` reproduces this exact sequence
and boots the pruned result, so a regression here fails CI rather than a deploy.

---

## Health & Monitoring Endpoints

* **Health Check:** `GET http://localhost:3000/health` (Returns status of Express, Redis, and SQLite)
* **Bull Board Dashboard:** `http://localhost:3000/admin/queues` (Public, read-only queue observability. No credentials in any environment; all mutating methods return `405`)
* **Grafana Visual Dashboard:** `http://localhost:3001` (*Login: `admin` / `admin`*)
* **Prometheus Metrics Scraper:** `GET http://localhost:3000/metrics` (or Prometheus UI at `http://localhost:9090`)

---

## Containerized Monitoring Services

The `docker-compose.yml` includes 3 fully integrated containers:

1. **`task_queue_redis`** (`redis:7-alpine`, port `6379`): Redis persistence datastore.
2. **`task_queue_prometheus`** (`prom/prometheus:v2.50.0`, port `9090`): Time-series metrics scraper.
3. **`task_queue_grafana`** (`grafana/grafana:10.3.3`, port `3001`): Auto-provisioned Grafana visualization dashboard.

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
