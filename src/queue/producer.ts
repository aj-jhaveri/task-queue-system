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
} from '../types/job.types.js';
import { logger } from '../logging/logger.js';

export async function dispatchEmailJob(payload: EmailJobDataInput): Promise<Job<EmailJobData>> {
  const validatedData = EmailJobDataSchema.parse(payload);
  const jobId = `email_${validatedData.idempotencyKey}`;

  const job = await taskQueue.add(JOB_NAMES.EMAIL_NOTIFICATION, validatedData, {
    jobId,
  });

  logger.info(
    { jobId: job.id, idempotencyKey: validatedData.idempotencyKey, recipient: validatedData.to },
    'Email job dispatched to queue'
  );

  return job;
}

export async function dispatchReportJob(payload: ReportJobDataInput): Promise<Job<ReportJobData>> {
  const validatedData = ReportJobDataSchema.parse(payload);
  const jobId = `report_${validatedData.idempotencyKey}`;

  const job = await taskQueue.add(JOB_NAMES.REPORT_GENERATION, validatedData, {
    jobId,
  });

  logger.info(
    { jobId: job.id, idempotencyKey: validatedData.idempotencyKey, reportType: validatedData.reportType },
    'Report job dispatched to queue'
  );

  return job;
}
