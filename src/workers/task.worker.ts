import { Worker, Job } from 'bullmq';
import { TASK_QUEUE_NAME } from '../queue/queue.js';
import { getRedisConnection } from '../config/redis.connection.js';
import { config } from '../config/environment.js';
import { logger } from '../logging/logger.js';
import { getProcessorForJob } from '../processors/registry.js';
import { metricsService } from '../metrics/metrics.service.js';
import { sendToDLQ } from '../queue/dlq.js';
import { JobExecutionResult } from '../types/job.types.js';

let taskWorkerInstance: Worker | null = null;

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
      connection: getRedisConnection(),
      concurrency: config.WORKER_CONCURRENCY,
      limiter: {
        max: config.RATE_LIMIT_MAX,
        duration: config.RATE_LIMIT_DURATION_MS,
      },
    }
  );

  taskWorkerInstance.on('completed', (job: Job, result: JobExecutionResult) => {
    const durationSeconds = result.durationMs ? result.durationMs / 1000 : 0;
    metricsService.jobsProcessedTotal.inc({ job_type: job.name, status: 'success' });
    metricsService.processingDuration.observe({ job_type: job.name }, durationSeconds);

    logger.info(
      { jobId: job.id, jobName: job.name, isDuplicate: result.isDuplicate, durationMs: result.durationMs },
      'Worker completed job processing'
    );
  });

  taskWorkerInstance.on('failed', async (job: Job | undefined, err: Error) => {
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
      `Worker job execution failed (Attempt ${attemptsMade}/${maxAttempts})`
    );

    // If all attempts are exhausted, route to DLQ
    if (job && attemptsMade >= maxAttempts) {
      try {
        await sendToDLQ(job, err);
      } catch (dlqErr) {
        logger.error({ dlqErr, jobId: job.id }, 'Failed to route job to Dead Letter Queue');
      }
    }
  });

  taskWorkerInstance.on('error', (err: Error) => {
    logger.error({ err }, 'Worker system error encountered');
  });

  logger.info(
    { concurrency: config.WORKER_CONCURRENCY, rateLimitMax: config.RATE_LIMIT_MAX },
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
