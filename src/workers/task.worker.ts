import { Worker, Job } from 'bullmq';
import { TASK_QUEUE_NAME } from '../queue/queue.js';
import { getRedisOptions } from '../config/redis.connection.js';
import { config } from '../config/environment.js';
import { logger } from '../logging/logger.js';
import { getProcessorForJob } from '../processors/registry.js';
import { metricsService } from '../metrics/metrics.service.js';
import { sendToDLQ } from '../queue/dlq.js';
import { JobExecutionResult } from '../types/job.types.js';
import { invalidateDashboardSnapshot } from '../middleware/dashboard.cache.js';

let taskWorkerInstance: Worker | null = null;

/**
 * Worker options that determine idle Redis command consumption.
 *
 * BullMQ's stock defaults (drainDelay: 5s, stalledInterval: 30s) cost roughly
 * 37,440 commands/day while completely idle:
 *   - bzpopmin on the marker key      1 cmd / 5s   = 17,280/day
 *   - moveToActive after each nil pop 1 cmd / 5s   = 17,280/day
 *   - moveStalledJobsToWait           1 cmd / 30s  =  2,880/day
 * That is ~1.12M commands/month, or 225% of the Upstash free tier's 500K cap,
 * before a single job is submitted.
 *
 * At drainDelay: 60 / stalledInterval: 300000 the idle cost drops to ~3,168/day
 * (~95K/month, ~19% of cap). Job pickup latency is UNAFFECTED: BullMQ's job-add
 * script writes a marker (ZADD) that immediately satisfies the blocked bzpopmin,
 * so a longer drainDelay only lengthens idle blocks, never job dispatch. Delayed
 * and retrying jobs use a separate code path capped at 10s internally, so
 * exponential backoff timing is likewise unaffected.
 *
 * Treat these two values as load-bearing for the hosting budget.
 */
export const WORKER_TUNING = {
  drainDelay: config.WORKER_DRAIN_DELAY_SECONDS,
  stalledInterval: config.WORKER_STALLED_INTERVAL_MS,
} as const;

export function initializeTaskWorker(): Worker {
  if (taskWorkerInstance) {
    return taskWorkerInstance;
  }

  taskWorkerInstance = new Worker(
    TASK_QUEUE_NAME,
    async (job: Job) => {
      const processor = getProcessorForJob(job.name);
      return await processor(job);
    },
    {
      connection: getRedisOptions(),
      concurrency: config.WORKER_CONCURRENCY,
      drainDelay: WORKER_TUNING.drainDelay,
      stalledInterval: WORKER_TUNING.stalledInterval,
      limiter: {
        max: config.RATE_LIMIT_MAX,
        duration: config.RATE_LIMIT_DURATION_MS,
      },
    }
  );

  taskWorkerInstance.on('completed', (job: Job, result: JobExecutionResult) => {
    // A job just changed state, so the public dashboard's cached snapshot is
    // stale. Invalidating on real events is what allows the idle TTL to be long.
    invalidateDashboardSnapshot();

    const durationSeconds = result.durationMs ? result.durationMs / 1000 : 0;
    metricsService.jobsProcessedTotal.inc({ job_type: job.name, status: 'success' });
    metricsService.processingDuration.observe({ job_type: job.name }, durationSeconds);

    logger.info(
      { jobId: job.id, jobName: job.name, isDuplicate: result.isDuplicate, durationMs: result.durationMs },
      'Worker completed job processing'
    );
  });

  taskWorkerInstance.on('failed', async (job: Job | undefined, err: Error) => {
    invalidateDashboardSnapshot();

    const jobName = job?.name || 'unknown';
    const attemptsMade = job?.attemptsMade || 0;
    const maxAttempts = job?.opts?.attempts || 3;

    metricsService.jobsFailedTotal.inc({ job_type: jobName, error_type: err.name || 'Error' });

    logger.error(
      {
        jobId: job?.id,
        jobName,
        attemptsMade,
        maxAttempts,
        errMessage: err.message,
      },
      `Worker job execution failed (attempt ${attemptsMade}/${maxAttempts})`
    );

    // If all attempts are exhausted, route to DLQ
    if (job && attemptsMade >= maxAttempts) {
      try {
        await sendToDLQ(job, err);
      } catch (dlqErr) {
        logger.error(
          { jobId: job.id, errMessage: dlqErr instanceof Error ? dlqErr.message : 'Unknown error' },
          'Failed to route job to Dead Letter Queue'
        );
      }
    }
  });

  taskWorkerInstance.on('error', (err: Error) => {
    // Suppress expected idle socket resets from serverless Upstash Redis
    const msg = err.message || '';
    if (msg.includes('ECONNRESET') || msg.includes('EPIPE') || msg.includes('Connection is closed')) {
      logger.debug('Worker socket auto-reconnected');
      return;
    }
    logger.error({ errMessage: msg }, 'Worker system error encountered');
  });

  logger.info(
    {
      concurrency: config.WORKER_CONCURRENCY,
      rateLimitMax: config.RATE_LIMIT_MAX,
      drainDelaySeconds: WORKER_TUNING.drainDelay,
      stalledIntervalMs: WORKER_TUNING.stalledInterval,
    },
    'Task worker initialized'
  );

  return taskWorkerInstance;
}

export async function stopTaskWorker(): Promise<void> {
  if (taskWorkerInstance) {
    await taskWorkerInstance.close();
    taskWorkerInstance = null;
    logger.info('Task worker stopped gracefully');
  }
}
