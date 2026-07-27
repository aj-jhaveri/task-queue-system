import { Queue, Job } from 'bullmq';
import { getRedisConnection } from '../config/redis.connection.js';
import { logger } from '../logging/logger.js';

export const DLQ_QUEUE_NAME = 'dlq-task-queue';

export const dlqQueue = new Queue(DLQ_QUEUE_NAME, {
  connection: getRedisConnection(),
  defaultJobOptions: {
    removeOnComplete: false,
    removeOnFail: false,
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
