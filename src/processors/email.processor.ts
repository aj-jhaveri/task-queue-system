import { Job } from 'bullmq';
import { EmailJobDataSchema, EmailJobData, JobExecutionResult, JOB_NAMES } from '../types/job.types.js';
import { idempotencyDb } from '../storage/idempotency.db.js';
import { logger } from '../logging/logger.js';

export async function processEmailJob(job: Job<EmailJobData>): Promise<JobExecutionResult> {
  const startTime = Date.now();
  const data = EmailJobDataSchema.parse(job.data);
  const { to, subject, body, idempotencyKey, simulateFailure, delayMs } = data;

  logger.info(
    { jobId: job.id, idempotencyKey, to, attempt: job.attemptsMade },
    'Processing Email Job'
  );

  // 1. Primary Datastore Idempotency Check
  if (idempotencyDb.hasBeenProcessed(idempotencyKey)) {
    const existing = idempotencyDb.getRecord(idempotencyKey);
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

  // 2. Artificial Processing Delay Simulation
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  // 3. Simulated Failure Injection
  if (simulateFailure) {
    const errorMsg = `Simulated Email Processor failure (attempt ${job.attemptsMade + 1})`;
    logger.error({ jobId: job.id, idempotencyKey, attempt: job.attemptsMade }, errorMsg);
    throw new Error(errorMsg);
  }

  // 4. Mock Email Side-Effect Logic
  const resultData = {
    messageId: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    deliveredTo: to,
    subject,
    bytesSent: Buffer.byteLength(body, 'utf-8'),
  };

  const durationMs = Date.now() - startTime;

  // 5. Record Execution Success in Primary Datastore
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
