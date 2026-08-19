import { Job } from 'bullmq';
import { JOB_NAMES, JobExecutionResult } from '../types/job.types.js';
import { processEmailJob } from './email.processor.js';
import { processWebhookJob } from './webhook.processor.js';

export type ProcessorFn = (job: Job<any>) => Promise<JobExecutionResult>;

const processorRegistry: Record<string, ProcessorFn> = {
  [JOB_NAMES.EMAIL_NOTIFICATION]: processEmailJob,
  [JOB_NAMES.WEBHOOK_DELIVERY]: processWebhookJob,
};

export function getProcessorForJob(jobName: string): ProcessorFn {
  const processor = processorRegistry[jobName];
  if (!processor) {
    throw new Error(`No processor registered for job type: ${jobName}`);
  }
  return processor;
}
