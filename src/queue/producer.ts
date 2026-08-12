import { Job } from 'bullmq';
import { taskQueue } from './queue.js';
import {
  JOB_NAMES,
  EmailJobDataSchema,
  EmailJobData,
  EmailJobDataInput,
  ReportJobDataSchema,
  ReportJobData,
  ReportJobDataInput,
  WebhookJobDataSchema,
  WebhookJobData,
  WebhookJobDataInput,
} from '../types/job.types.js';
import { config } from '../config/environment.js';
import { logger } from '../logging/logger.js';
import { QueueDepthExceededError, QueueUnavailableError } from '../errors/app.errors.js';
import { invalidateDashboardSnapshot } from '../middleware/dashboard.cache.js';

interface DepthCacheEntry {
  depth: number;
  expiresAt: number;
}

let depthCache: DepthCacheEntry | null = null;

/**
 * Reads pending queue depth, memoized for QUEUE_DEPTH_CACHE_TTL_MS.
 *
 * This is strictly demand-driven: it runs only inside a job-submit request. There
 * is deliberately NO background timer or interval polling Redis for depth. A
 * permanent 10-second depth poll would cost 8,640 Redis commands/day (~259K/month,
 * over half the Upstash free tier) purely to observe an idle queue. With the TTL
 * cache, cost is bounded by min(request rate, 1 command per TTL window), which is
 * negligible for real traffic and zero while nobody is submitting jobs.
 */
async function getPendingQueueDepth(): Promise<number> {
  const now = Date.now();
  if (depthCache && depthCache.expiresAt > now) {
    return depthCache.depth;
  }

  const counts = await taskQueue.getJobCounts('waiting', 'active', 'delayed');
  const depth = (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);

  depthCache = { depth, expiresAt: now + config.QUEUE_DEPTH_CACHE_TTL_MS };
  return depth;
}

/** Exposed for tests so cached depth does not leak across cases. */
export function resetQueueDepthCache(): void {
  depthCache = null;
}

/**
 * Enforces the queue-depth ceiling before accepting new work.
 * A Redis failure here surfaces as QueueUnavailableError (503) rather than an
 * indefinite hang, because producer connections use enableOfflineQueue: false.
 */
async function assertQueueHasCapacity(): Promise<void> {
  let depth: number;
  try {
    depth = await getPendingQueueDepth();
  } catch (err) {
    throw new QueueUnavailableError(err instanceof Error ? err.message : undefined);
  }

  if (depth >= config.MAX_QUEUE_DEPTH) {
    logger.warn(
      { depth, limit: config.MAX_QUEUE_DEPTH },
      'Rejecting job submission: queue depth ceiling reached'
    );
    throw new QueueDepthExceededError(depth, config.MAX_QUEUE_DEPTH);
  }
}

/**
 * Shared enqueue path for every job type.
 *
 * Centralizing this keeps three invariants impossible to forget when a new job
 * type is added: the depth ceiling is always enforced, an enqueue failure always
 * surfaces as a 503 rather than a hang, and the dashboard snapshot is always
 * invalidated so the public board reflects the new job on the very next poll.
 */
async function enqueue<T>(
  jobName: string,
  jobId: string,
  data: T,
  logContext: Record<string, unknown>,
  message: string
): Promise<Job<T>> {
  await assertQueueHasCapacity();

  let job: Job<T>;
  try {
    job = await taskQueue.add(jobName, data, { jobId });
  } catch (err) {
    throw new QueueUnavailableError(err instanceof Error ? err.message : undefined);
  }

  // Queue state just changed, so any cached dashboard snapshot is now wrong.
  // This is what lets the public board poll cheaply while still going live the
  // moment a visitor dispatches something.
  invalidateDashboardSnapshot();

  logger.info({ jobId: job.id, ...logContext }, message);

  return job;
}

export async function dispatchEmailJob(payload: EmailJobDataInput): Promise<Job<EmailJobData>> {
  const validatedData = EmailJobDataSchema.parse(payload);

  return enqueue(
    JOB_NAMES.EMAIL_NOTIFICATION,
    `email_${validatedData.idempotencyKey}`,
    validatedData,
    // Recipient address is intentionally omitted from logs: it is user-supplied PII.
    { idempotencyKey: validatedData.idempotencyKey },
    'Email job dispatched to queue'
  );
}

export async function dispatchReportJob(payload: ReportJobDataInput): Promise<Job<ReportJobData>> {
  const validatedData = ReportJobDataSchema.parse(payload);

  return enqueue(
    JOB_NAMES.REPORT_GENERATION,
    `report_${validatedData.idempotencyKey}`,
    validatedData,
    { idempotencyKey: validatedData.idempotencyKey, reportType: validatedData.reportType },
    'Report job dispatched to queue'
  );
}

export async function dispatchWebhookJob(
  payload: WebhookJobDataInput
): Promise<Job<WebhookJobData>> {
  const validatedData = WebhookJobDataSchema.parse(payload);

  return enqueue(
    JOB_NAMES.WEBHOOK_DELIVERY,
    `webhook_${validatedData.idempotencyKey}`,
    validatedData,
    { idempotencyKey: validatedData.idempotencyKey, destination: validatedData.destination },
    'Webhook delivery job dispatched to queue'
  );
}
