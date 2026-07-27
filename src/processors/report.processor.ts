import { Job } from 'bullmq';
import { ReportJobDataSchema, ReportJobData, JobExecutionResult, JOB_NAMES } from '../types/job.types.js';
import { idempotencyDb } from '../storage/idempotency.db.js';
import { logger } from '../logging/logger.js';

export async function processReportJob(job: Job<ReportJobData>): Promise<JobExecutionResult> {
  const startTime = Date.now();
  const data = ReportJobDataSchema.parse(job.data);
  const { reportType, userEmail, filters, idempotencyKey, simulateFailure, delayMs } = data;

  logger.info(
    { jobId: job.id, idempotencyKey, reportType, userEmail, attempt: job.attemptsMade },
    'Processing Report Generation Job'
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
      jobName: JOB_NAMES.REPORT_GENERATION,
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
    const errorMsg = `Simulated Report Processor failure (attempt ${job.attemptsMade + 1})`;
    logger.error({ jobId: job.id, idempotencyKey, attempt: job.attemptsMade }, errorMsg);
    throw new Error(errorMsg);
  }

  // 4. Mock Report Side-Effect Logic
  const resultData = {
    reportId: `rpt_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    reportType,
    generatedFor: userEmail,
    appliedFilters: filters,
    downloadUrl: `https://reports.internal/download/rpt_${Date.now()}.pdf`,
    rowsProcessed: Math.floor(Math.random() * 5000) + 100,
  };

  const durationMs = Date.now() - startTime;

  // 5. Record Execution Success in Primary Datastore
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
