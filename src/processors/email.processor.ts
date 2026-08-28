import { Job } from 'bullmq';
import { EmailJobRecordSchema, EmailJobData, JobExecutionResult, JOB_NAMES } from '../types/job.types.js';
import { idempotencyDb } from '../storage/idempotency.db.js';
import { logger } from '../logging/logger.js';

/**
 * Processes an email notification job.
 *
 * There is no artificial failure or delay switch here. Any error thrown by this
 * processor is a genuine failure and is handled by BullMQ's real retry path:
 * up to `attempts` tries with exponential backoff, then DLQ routing.
 */
export async function processEmailJob(job: Job<EmailJobData>): Promise<JobExecutionResult> {
  const startTime = Date.now();
  // Record schema, not the public input schema: job.data carries the
  // server-stamped correlationId, which the strict input schema would reject.
  const data = EmailJobRecordSchema.parse(job.data);
  const { to, subject, body, idempotencyKey } = data;

  logger.info({ jobId: job.id, idempotencyKey, attempt: job.attemptsMade }, 'Processing email job');

  // 1. Primary datastore idempotency check
  if (idempotencyDb.hasBeenProcessed(JOB_NAMES.EMAIL_NOTIFICATION, idempotencyKey)) {
    const existing = idempotencyDb.getRecord(JOB_NAMES.EMAIL_NOTIFICATION, idempotencyKey);
    logger.warn(
      { jobId: job.id, idempotencyKey },
      'Duplicate job execution blocked by SQLite primary datastore idempotency check'
    );
    return {
      success: true,
      jobName: JOB_NAMES.EMAIL_NOTIFICATION,
      idempotencyKey,
      processedAt: existing?.created_at || new Date().toISOString(),
      durationMs: 0,
      data: JSON.parse(existing?.result_json || '{}'),
      isDuplicate: true,
    };
  }

  // 2. Email side-effect - SIMULATED.
  //
  // No SMTP provider is contacted and no mail is sent. The messageId is
  // generated locally so the idempotency record has a realistic payload to
  // replay on a duplicate.
  //
  // This job exists to exercise the queue lifecycle - validation, idempotency,
  // durable success record - without requiring a vendor account, which is what
  // lets the deployment run unattended. It is deliberately NOT the job that
  // demonstrates retries: WEBHOOK_DELIVERY performs a real HTTP request to a
  // path that genuinely is not served, so backoff and DLQ routing rest on a
  // real failure rather than on a simulation flag. The asymmetry between these
  // two processors is intentional and is documented in the README.
  const resultData = {
    messageId: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    deliveredTo: to,
    subject,
    bytesSent: Buffer.byteLength(body, 'utf-8'),
  };

  const durationMs = Date.now() - startTime;

  // 3. Record execution success in the primary datastore
  idempotencyDb.recordSuccess(idempotencyKey, JOB_NAMES.EMAIL_NOTIFICATION, resultData);

  logger.info(
    { jobId: job.id, idempotencyKey, durationMs, messageId: resultData.messageId },
    'Email job successfully executed'
  );

  return {
    success: true,
    jobName: JOB_NAMES.EMAIL_NOTIFICATION,
    idempotencyKey,
    processedAt: new Date().toISOString(),
    durationMs,
    data: resultData,
  };
}
