import { Job } from 'bullmq';
import {
  WebhookJobDataSchema,
  WebhookJobData,
  WebhookDestination,
  JobExecutionResult,
  JOB_NAMES,
} from '../types/job.types.js';
import { config } from '../config/environment.js';
import { idempotencyDb } from '../storage/idempotency.db.js';
import { logger } from '../logging/logger.js';

/**
 * Path served by this same process that accepts a delivery and returns 200.
 * Loopback is used deliberately: the demo must not depend on any third-party
 * endpoint staying up, because the whole promise of this deployment is that it
 * keeps working unattended.
 */
export const WEBHOOK_SINK_PATH = '/internal/webhook-sink';

/**
 * Path that is deliberately not served. A delivery here fails for a real reason
 * that is visible in the response - a 404 from a live HTTP server - rather than
 * through a simulation flag inside the processor. The processor contains no
 * branch that decides to fail; it simply reports what the network told it.
 */
export const WEBHOOK_UNAVAILABLE_PATH = '/internal/webhook-sink/unavailable';

/** Maps a named destination onto a concrete loopback URL. Never client-supplied. */
export function resolveWebhookDestination(destination: WebhookDestination): string {
  const base = `http://127.0.0.1:${config.PORT}`;
  return destination === 'DEMO_AVAILABLE'
    ? `${base}${WEBHOOK_SINK_PATH}`
    : `${base}${WEBHOOK_UNAVAILABLE_PATH}`;
}

/**
 * Delivers a webhook over real HTTP.
 *
 * Any non-2xx response or transport error throws, which hands the job back to
 * BullMQ for a genuine retry with exponential backoff, and to the DLQ once
 * `attempts` is exhausted. There is no artificial failure switch anywhere in this
 * path: a failed delivery failed because the HTTP request failed.
 */
export async function processWebhookJob(job: Job<WebhookJobData>): Promise<JobExecutionResult> {
  const startTime = Date.now();
  const data = WebhookJobDataSchema.parse(job.data);
  const { destination, event, payload, idempotencyKey } = data;

  logger.info(
    { jobId: job.id, idempotencyKey, destination, event, attempt: job.attemptsMade },
    'Processing webhook delivery job'
  );

  if (idempotencyDb.hasBeenProcessed(idempotencyKey)) {
    const existing = idempotencyDb.getRecord(idempotencyKey);
    logger.warn(
      { jobId: job.id, idempotencyKey },
      'Duplicate job execution blocked by SQLite primary datastore idempotency check'
    );
    return {
      success: true,
      jobName: JOB_NAMES.WEBHOOK_DELIVERY,
      idempotencyKey,
      processedAt: existing?.created_at || new Date().toISOString(),
      durationMs: 0,
      data: JSON.parse(existing?.result_json || '{}'),
      isDuplicate: true,
    };
  }

  const targetUrl = resolveWebhookDestination(destination);

  let response: Response;
  try {
    response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({ event, payload }),
      signal: AbortSignal.timeout(config.WEBHOOK_TIMEOUT_MS),
    });
  } catch (err) {
    // Transport-level failure (refused, reset, timed out). Rethrown as a plain
    // Error so BullMQ's retry path handles it identically to an HTTP failure.
    const reason = err instanceof Error ? err.message : 'Unknown transport error';
    throw new Error(`Webhook delivery to ${destination} failed at transport level: ${reason}`);
  }

  if (!response.ok) {
    throw new Error(
      `Webhook delivery to ${destination} was rejected with HTTP ${response.status}`
    );
  }

  const resultData = {
    destination,
    event,
    httpStatus: response.status,
    deliveredAt: new Date().toISOString(),
  };

  const durationMs = Date.now() - startTime;
  idempotencyDb.recordSuccess(idempotencyKey, JOB_NAMES.WEBHOOK_DELIVERY, resultData);

  logger.info(
    { jobId: job.id, idempotencyKey, destination, httpStatus: response.status, durationMs },
    'Webhook delivered successfully'
  );

  return {
    success: true,
    jobName: JOB_NAMES.WEBHOOK_DELIVERY,
    idempotencyKey,
    processedAt: new Date().toISOString(),
    durationMs,
    data: resultData,
  };
}
