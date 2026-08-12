import { Job } from 'bullmq';
import { ReportJobDataSchema, ReportJobData, JobExecutionResult, JOB_NAMES } from '../types/job.types.js';
import { idempotencyDb } from '../storage/idempotency.db.js';
import { logger } from '../logging/logger.js';

/**
 * Processes a report generation job.
 *
 * There is no artificial failure or delay switch here. Any error thrown by this
 * processor is a genuine failure and is handled by BullMQ's real retry path:
 * up to `attempts` tries with exponential backoff, then DLQ routing.
 */
export async function processReportJob(job: Job<ReportJobData>): Promise<JobExecutionResult> {
  const startTime = Date.now();
  const data = ReportJobDataSchema.parse(job.data);
  const { reportType, userEmail, filters, idempotencyKey } = data;

  logger.info(
    { jobId: job.id, idempotencyKey, reportType, attempt: job.attemptsMade },
    'Processing report generation job'
  );

  // 1. Primary datastore idempotency check
  if (idempotencyDb.hasBeenProcessed(idempotencyKey)) {
    const existing = idempotencyDb.getRecord(idempotencyKey);
    logger.warn(
      { jobId: job.id, idempotencyKey },
      'Duplicate job execution blocked by SQLite primary datastore idempotency check'
    );
    return {
      success: true,
      jobName: JOB_NAMES.REPORT_GENERATION,
      idempotencyKey,
      processedAt: existing?.created_at || new Date().toISOString(),
      durationMs: 0,
      data: JSON.parse(existing?.result_json || '{}'),
      isDuplicate: true,
    };
  }

  // 2. Report generation side-effect
  const resultData = {
    reportId: `rpt_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    reportType,
    generatedFor: userEmail,
    appliedFilters: filters,
    downloadUrl: `https://reports.internal/download/rpt_${Date.now()}.pdf`,
    rowsProcessed: Math.floor(Math.random() * 5000) + 100,
  };

  const durationMs = Date.now() - startTime;

  // 3. Record execution success in the primary datastore
  idempotencyDb.recordSuccess(idempotencyKey, JOB_NAMES.REPORT_GENERATION, resultData);

  logger.info(
    { jobId: job.id, idempotencyKey, durationMs, reportId: resultData.reportId },
    'Report job successfully executed'
  );

  return {
    success: true,
    jobName: JOB_NAMES.REPORT_GENERATION,
    idempotencyKey,
    processedAt: new Date().toISOString(),
    durationMs,
    data: resultData,
  };
}
