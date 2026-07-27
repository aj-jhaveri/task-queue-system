import express, { Request, Response, NextFunction } from 'express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { ZodError } from 'zod';

import { config } from './config/environment.js';
import { logger } from './logging/logger.js';
import { getRedisConnection, closeRedisConnection } from './config/redis.connection.js';
import { taskQueue } from './queue/queue.js';
import { dlqQueue } from './queue/dlq.js';
import { dispatchEmailJob, dispatchReportJob } from './queue/producer.js';
import { initializeTaskWorker, stopTaskWorker } from './workers/task.worker.js';
import { metricsService } from './metrics/metrics.service.js';
import { idempotencyDb } from './storage/idempotency.db.js';

const app = express();
app.use(express.json());

// Set up Bull Board Admin UI
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
  queues: [new BullMQAdapter(taskQueue), new BullMQAdapter(dlqQueue)],
  serverAdapter,
});

app.use('/admin/queues', serverAdapter.getRouter());

// Health Check Endpoint
app.get('/health', async (_req: Request, res: Response) => {
  let redisStatus = 'DOWN';
  let dbStatus = 'DOWN';

  try {
    const redis = getRedisConnection();
    const pingRes = await redis.ping();
    if (pingRes === 'PONG') redisStatus = 'UP';
  } catch (err) {
    logger.error({ err }, 'Health check Redis ping failed');
  }

  try {
    idempotencyDb.getRecord('health_check_ping');
    dbStatus = 'UP';
  } catch (err) {
    logger.error({ err }, 'Health check SQLite query failed');
  }

  const isHealthy = redisStatus === 'UP' && dbStatus === 'UP';
  const status = isHealthy ? 200 : 503;

  res.status(status).json({
    status: isHealthy ? 'HEALTHY' : 'UNHEALTHY',
    timestamp: new Date().toISOString(),
    services: {
      redis: redisStatus,
      sqlite: dbStatus,
      worker: 'UP',
    },
  });
});

// Prometheus Metrics Endpoint
app.get('/metrics', async (_req: Request, res: Response) => {
  try {
    // Update queue depth metric gauge
    const counts = await taskQueue.getJobCounts('active', 'completed', 'failed', 'delayed', 'waiting');
    metricsService.queueDepthGauge.set({ queue_name: taskQueue.name, state: 'active' }, counts.active);
    metricsService.queueDepthGauge.set({ queue_name: taskQueue.name, state: 'completed' }, counts.completed);
    metricsService.queueDepthGauge.set({ queue_name: taskQueue.name, state: 'failed' }, counts.failed);
    metricsService.queueDepthGauge.set({ queue_name: taskQueue.name, state: 'delayed' }, counts.delayed);
    metricsService.queueDepthGauge.set({ queue_name: taskQueue.name, state: 'waiting' }, counts.waiting);

    res.set('Content-Type', metricsService.getMetricsContentType());
    res.end(await metricsService.getMetrics());
  } catch (err) {
    logger.error({ err }, 'Failed to generate metrics');
    res.status(500).send('Metrics generation error');
  }
});

// REST Endpoint: Dispatch Email Job
app.post('/api/jobs/email', async (req: Request, res: Response, next: NextFunction) => {
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
});

// REST Endpoint: Dispatch Report Job
app.post('/api/jobs/report', async (req: Request, res: Response, next: NextFunction) => {
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
});

// Centralized Error Handling Middleware
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Invalid Payload Schema',
      details: err.errors,
    });
    return;
  }

  const message = err instanceof Error ? err.message : 'Internal Server Error';
  logger.error({ err }, 'API Endpoint Error');
  res.status(500).json({ error: message });
});

// Initialize Worker
initializeTaskWorker();

// Start Server
const server = app.listen(config.PORT, () => {
  logger.info(
    `Server running on http://localhost:${config.PORT} | Bull Board: http://localhost:${config.PORT}/admin/queues | Metrics: http://localhost:${config.PORT}/metrics`
  );
});

// Graceful Shutdown Logic
async function gracefulShutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Received shutdown signal. Commencing graceful shutdown...');

  server.close(async () => {
    logger.info('HTTP server closed');
    try {
      await stopTaskWorker();
      await taskQueue.close();
      await dlqQueue.close();
      idempotencyDb.close();
      await closeRedisConnection();
      logger.info('Graceful shutdown completed. Exiting process.');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during graceful shutdown');
      process.exit(1);
    }
  });

  // Force exit if shutdown takes longer than 10 seconds
  setTimeout(() => {
    logger.fatal('Forced shutdown after 10s timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

export { app };
