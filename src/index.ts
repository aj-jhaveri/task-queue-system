import { config, assertRedisConfigValid } from './config/environment.js';
import { logger } from './logging/logger.js';
import { closeRedisConnection } from './config/redis.connection.js';
import { taskQueue } from './queue/queue.js';
import { dlqQueue } from './queue/dlq.js';
import { initializeTaskWorker, stopTaskWorker } from './workers/task.worker.js';
import { idempotencyDb } from './storage/idempotency.db.js';
import { buildApp } from './app.js';

// Fail fast on a malformed Redis configuration, before any connection attempt.
// The thrown message never contains the connection string.
assertRedisConfigValid();

const app = buildApp();

const server = app.listen(config.PORT, () => {
  // The API and worker intentionally share one process and one Render service.
  //
  // The worker starts only once the HTTP server is accepting connections, because
  // WEBHOOK_DELIVERY jobs deliver over loopback to this same process. Starting the
  // worker first leaves a window where a job left in the queue from a previous
  // deploy is picked up before the listener exists, fails with ECONNREFUSED, and
  // burns a retry attempt on a dependency that was never actually down.
  initializeTaskWorker();

  logger.info(
    {
      port: config.PORT,
      adminAuthConfigured: config.adminAuthConfigured,
      corsAllowedOrigins: config.corsAllowedOrigins.length,
    },
    'Server started'
  );

  if (!config.adminAuthConfigured) {
    // The queue dashboard is public and read-only, so it is unaffected by this.
    // Only /metrics is gated by these credentials.
    logger.info(
      'BULLBOARD_USER/BULLBOARD_PASSWORD are unset: /metrics will refuse all requests. The public read-only queue dashboard is unaffected.'
    );
  }
});

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Received shutdown signal. Commencing graceful shutdown...');

  const forceExit = setTimeout(() => {
    logger.fatal('Forced shutdown after 10s timeout');
    process.exit(1);
  }, 10000);
  // Do not let the force-exit timer hold the event loop open on a clean exit.
  forceExit.unref();

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
      logger.error(
        { errMessage: err instanceof Error ? err.message : 'Unknown error' },
        'Error during graceful shutdown'
      );
      process.exit(1);
    }
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

export { app };
