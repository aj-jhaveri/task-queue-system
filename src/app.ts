import express, { Express, Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { ZodError } from 'zod';

import { config } from './config/environment.js';
import { logger, redactSecrets } from './logging/logger.js';
import { getRedisConnection } from './config/redis.connection.js';
import { taskQueue } from './queue/queue.js';
import { dlqQueue } from './queue/dlq.js';
import { dispatchEmailJob, dispatchReportJob, dispatchWebhookJob } from './queue/producer.js';
import { metricsService } from './metrics/metrics.service.js';
import { idempotencyDb } from './storage/idempotency.db.js';
import { requireAdminAuth } from './middleware/admin.auth.js';
import { corsMiddleware } from './middleware/cors.js';
import { perIpJobLimiter, globalJobLimiter, dashboardLimiter } from './middleware/rate.limit.js';
import { dashboardReadOnlyGuard, blockRedisStatsRoute } from './middleware/dashboard.guard.js';
import { dashboardSnapshotCache, setDashboardQueueNames } from './middleware/dashboard.cache.js';
import { WEBHOOK_SINK_PATH, WEBHOOK_UNAVAILABLE_PATH } from './processors/webhook.processor.js';
import { QueueDepthExceededError, QueueUnavailableError } from './errors/app.errors.js';

/**
 * Bull Board client polling interval, in seconds.
 *
 * Unlike the pre-remediation deployment, this value is no longer the thing that
 * protects the Redis budget - `dashboardSnapshotCache` is. Polls are answered from
 * an in-process snapshot, so the interval controls how quickly a visitor sees a
 * change, not how much Redis costs. That is why it is set to a responsive 10s
 * rather than a defensive 60s: a visitor who dispatches a job should watch it
 * appear, and doing so costs nothing extra.
 *
 * `forceInterval` is verified present in the installed @bull-board/api typings
 * (typings/app.d.ts: UIConfig.pollingInterval.forceInterval) and is honoured by
 * the bundled UI, which reads it into its polling state on load.
 */
export const BULL_BOARD_POLLING_INTERVAL_SECONDS = config.DASHBOARD_POLL_INTERVAL_SECONDS;

/**
 * Builds the Express application without binding a port or starting the worker,
 * so tests can exercise the real HTTP stack in isolation.
 */
export function buildApp(): Express {
  const app = express();

  // Render terminates TLS at its load balancer and forwards the client address in
  // X-Forwarded-For. Without this, req.ip is the proxy's address and every request
  // shares a single rate-limit bucket, which would make per-IP limiting useless.
  // A specific hop count is used rather than `true`, which would trust any
  // client-supplied X-Forwarded-For header and allow limit evasion by spoofing.
  app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // Bull Board serves its own bundled scripts and inline styles.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    })
  );

  app.use(corsMiddleware);
  app.use(express.json({ limit: config.JSON_BODY_LIMIT }));

  // Public service index. The queue dashboard is advertised because it is a
  // read-only public surface by design.
  app.get('/', (_req: Request, res: Response) => {
    res.json({
      service: 'Slake Design Task Queue Microservice',
      status: 'ONLINE',
      version: '1.0.0',
      endpoints: {
        health: '/health',
        queueDashboard: '/admin/queues',
        dispatchEmailJob: 'POST /api/jobs/email',
        dispatchReportJob: 'POST /api/jobs/report',
        dispatchWebhookJob: 'POST /api/jobs/webhook',
      },
    });
  });

  // Public, read-only Bull Board.
  //
  // Open access is a deliberate product decision: the dashboard is the artifact
  // being demonstrated, and putting it behind a login defeats its purpose. Making
  // that safe and affordable takes three independent controls, because the two
  // risks of an open dashboard are unrelated:
  //
  //   Mutation - `readOnlyMode` only hides UI controls; the mutating routes stay
  //     mounted. `dashboardReadOnlyGuard` refuses non-GET methods outright, which
  //     is the control that actually prevents an anonymous drain or obliterate.
  //   Cost     - `dashboardSnapshotCache` answers the polled data route from
  //     memory, so Redis spend is decoupled from viewer count and poll rate. This
  //     is what makes an always-on public board viable on a free Redis tier. The
  //     cache keys on validated parameters only, and a global refresh budget caps
  //     rebuilds across all callers, so neither a rotated query string nor a fleet
  //     of IPs can convert the board back into an uncached one.
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/queues');

  // The snapshot cache validates `activeQueue` against this list, so a request for
  // a queue that was never registered collapses onto the default view instead of
  // minting a snapshot of its own.
  setDashboardQueueNames([taskQueue.name, dlqQueue.name]);

  createBullBoard({
    queues: [
      new BullMQAdapter(taskQueue, { readOnlyMode: true }),
      new BullMQAdapter(dlqQueue, { readOnlyMode: true }),
    ],
    serverAdapter,
    options: {
      uiConfig: {
        pollingInterval: {
          showSetting: true,
          forceInterval: BULL_BOARD_POLLING_INTERVAL_SECONDS,
        },
        // Keeps Redis version/host details out of the public UI.
        hideRedisDetails: true,
      },
    },
  });

  //   Amplification - job-detail routes are intentionally uncached, so each one
  //     reaches Redis. `dashboardLimiter` caps them per IP, closing the last
  //     uncapped path on an unauthenticated surface.
  app.use(
    '/admin/queues',
    dashboardReadOnlyGuard,
    blockRedisStatsRoute,
    dashboardLimiter,
    dashboardSnapshotCache,
    serverAdapter.getRouter()
  );

  // Health check. Left unauthenticated so external uptime monitors can reach it.
  // Costs zero Redis commands on the normal path: a ready connection short-circuits
  // before any PING is issued.
  app.get('/health', async (_req: Request, res: Response) => {
    let redisStatus = 'DOWN';
    let dbStatus = 'DOWN';

    try {
      const redis = getRedisConnection();
      if (redis.status === 'ready') {
        redisStatus = 'UP';
      } else {
        const pingPromise = redis.ping();
        const timeoutPromise = new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Redis ping timeout')), 2500)
        );
        const pingRes = await Promise.race([pingPromise, timeoutPromise]);
        if (pingRes === 'PONG') redisStatus = 'UP';
      }
    } catch (err) {
      logger.warn(
        { errMessage: err instanceof Error ? redactSecrets(err.message) : 'Unknown error' },
        'Redis health check ping failed'
      );
    }

    try {
      idempotencyDb.getRecord('health_check_ping');
      dbStatus = 'UP';
    } catch (err) {
      logger.error(
        { errMessage: err instanceof Error ? err.message : 'Unknown error' },
        'Health check SQLite query failed'
      );
    }

    const isHealthy = redisStatus === 'UP' && dbStatus === 'UP';

    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? 'HEALTHY' : 'DEGRADED',
      timestamp: new Date().toISOString(),
      services: { redis: redisStatus, sqlite: dbStatus, worker: 'UP' },
    });
  });

  // Prometheus metrics. Protected everywhere except explicit local development,
  // where the docker-compose Prometheus scrapes it without credentials.
  // Fail-safe: an unset NODE_ENV is treated as deployed, so forgetting the variable
  // leaves metrics protected rather than exposed.
  const metricsGuards = config.isExplicitDevelopment ? [] : [requireAdminAuth];

  app.get('/metrics', ...metricsGuards, async (_req: Request, res: Response) => {
    try {
      const counts = await taskQueue.getJobCounts(
        'active',
        'completed',
        'failed',
        'delayed',
        'waiting'
      );
      const gauge = metricsService.queueDepthGauge;
      gauge.set({ queue_name: taskQueue.name, state: 'active' }, counts.active);
      gauge.set({ queue_name: taskQueue.name, state: 'completed' }, counts.completed);
      gauge.set({ queue_name: taskQueue.name, state: 'failed' }, counts.failed);
      gauge.set({ queue_name: taskQueue.name, state: 'delayed' }, counts.delayed);
      gauge.set({ queue_name: taskQueue.name, state: 'waiting' }, counts.waiting);

      res.set('Content-Type', metricsService.getMetricsContentType());
      res.end(await metricsService.getMetrics());
    } catch (err) {
      logger.error(
        { errMessage: err instanceof Error ? redactSecrets(err.message) : 'Unknown error' },
        'Failed to generate metrics'
      );
      res.status(500).send('Metrics generation error');
    }
  });

  // Job intake. Global ceiling is evaluated before the per-IP bucket so a
  // distributed burst is capped in aggregate as well as per client.
  app.post(
    '/api/jobs/email',
    globalJobLimiter,
    perIpJobLimiter,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const job = await dispatchEmailJob(req.body);
        res.status(202).json({
          message: 'Email job dispatched successfully',
          jobId: job.id,
          idempotencyKey: job.data.idempotencyKey,
          status: 'QUEUED',
        });
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    '/api/jobs/report',
    globalJobLimiter,
    perIpJobLimiter,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const job = await dispatchReportJob(req.body);
        res.status(202).json({
          message: 'Report job dispatched successfully',
          jobId: job.id,
          idempotencyKey: job.data.idempotencyKey,
          status: 'QUEUED',
        });
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    '/api/jobs/webhook',
    globalJobLimiter,
    perIpJobLimiter,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const job = await dispatchWebhookJob(req.body);
        res.status(202).json({
          message: 'Webhook delivery job dispatched successfully',
          jobId: job.id,
          idempotencyKey: job.data.idempotencyKey,
          destination: job.data.destination,
          status: 'QUEUED',
        });
      } catch (error) {
        next(error);
      }
    }
  );

  // Delivery sink for WEBHOOK_DELIVERY jobs.
  //
  // Restricted to loopback: the worker reaches it in-process over 127.0.0.1, and
  // nothing outside this container has any reason to. Note that no route is
  // registered for WEBHOOK_UNAVAILABLE_PATH - that is the point. A job aimed at the
  // unavailable destination fails because the endpoint genuinely does not exist,
  // so the retry demonstration rests on a real HTTP failure rather than on a
  // simulation flag the processor could have been asked to honour.
  app.post(WEBHOOK_SINK_PATH, (req: Request, res: Response) => {
    const callerIp = req.ip ?? '';
    const isLoopback =
      callerIp === '127.0.0.1' || callerIp === '::1' || callerIp === '::ffff:127.0.0.1';

    if (!isLoopback) {
      res.status(403).json({ error: 'This endpoint is reachable from loopback only.' });
      return;
    }

    res.status(200).json({ received: true, at: new Date().toISOString() });
  });

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: `Cannot ${req.method} ${req.path}` });
  });

  // Centralized error handling. Client-facing bodies never contain internal
  // messages, stack traces, or configuration values.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({
        error: 'Invalid payload schema',
        details: err.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      });
      return;
    }

    if (err instanceof QueueDepthExceededError || err instanceof QueueUnavailableError) {
      logger.warn({ errMessage: err.message }, 'Job submission rejected by safety limit');
      res.status(err.statusCode).json({ error: err.publicMessage });
      return;
    }

    // Malformed JSON and oversized bodies arrive as http-errors with a status.
    const httpErr = err as { status?: number; statusCode?: number; type?: string };
    const status = httpErr.status ?? httpErr.statusCode;
    if (status === 400 && httpErr.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Malformed JSON body.' });
      return;
    }
    if (status === 413) {
      res.status(413).json({ error: 'Request body too large.' });
      return;
    }

    logger.error(
      {
        errMessage: err instanceof Error ? redactSecrets(err.message) : 'Unknown error',
        errName: err instanceof Error ? err.name : undefined,
      },
      'Unhandled API error'
    );

    // Generic body: internal error text is confined to server-side logs.
    res.status(500).json({ error: 'Internal server error.' });
  });

  return app;
}
