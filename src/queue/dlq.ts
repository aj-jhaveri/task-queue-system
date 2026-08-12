import { Queue, Job } from 'bullmq';
import { getProducerRedisOptions } from '../config/redis.connection.js';
import { logger } from '../logging/logger.js';

export const DLQ_QUEUE_NAME = 'dlq-task-queue';

/**
 * Dead Letter Queue for jobs that exhausted every retry attempt.
 *
 * Retention is bounded. Previously both removeOnComplete and removeOnFail were
 * `false`, meaning DLQ entries accumulated forever and Redis storage grew without
 * limit. A 30-day / 1,000-entry ceiling keeps real failures inspectable while
 * remaining bounded.
 */
const DLQ_RETENTION_SECONDS = 60 * 60 * 24 * 30;

export const dlqQueue = new Queue(DLQ_QUEUE_NAME, {
  connection: getProducerRedisOptions(),
  defaultJobOptions: {
    removeOnComplete: { count: 1000, age: DLQ_RETENTION_SECONDS },
    removeOnFail: { count: 1000, age: DLQ_RETENTION_SECONDS },
  },
});

export interface DLQPayload {
  originalJobId: string | undefined;
  jobName: string;
  data: Record<string, unknown>;
  failedReason: string;
  failedAt: string;
  attemptsMade: number;
  stacktrace?: string[];
}

export async function sendToDLQ(job: Job, error: Error): Promise<void> {
  const payload: DLQPayload = {
    originalJobId: job.id,
    jobName: job.name,
    data: job.data,
    failedReason: error.message || 'Unknown error',
    failedAt: new Date().toISOString(),
    attemptsMade: job.attemptsMade,
    stacktrace: job.stacktrace ?? undefined,
  };

  const dlqJob = await dlqQueue.add(`DLQ_${job.name}`, payload, {
    jobId: `dlq_${job.id}_${Date.now()}`,
  });

  logger.error(
    {
      dlqJobId: dlqJob.id,
      originalJobId: job.id,
      jobName: job.name,
      reason: error.message,
    },
    'Job exhausted all retry attempts and moved to Dead Letter Queue (DLQ)'
  );
}
