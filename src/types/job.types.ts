import { z } from 'zod';

export const JOB_NAMES = {
  EMAIL_NOTIFICATION: 'EMAIL_NOTIFICATION',
  REPORT_GENERATION: 'REPORT_GENERATION',
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

export const EmailJobDataSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string(),
  idempotencyKey: z.string().min(1),
  simulateFailure: z.boolean().optional().default(false),
  delayMs: z.number().nonnegative().optional().default(0),
});

export type EmailJobData = z.infer<typeof EmailJobDataSchema>;
export type EmailJobDataInput = z.input<typeof EmailJobDataSchema>;

export const ReportJobDataSchema = z.object({
  reportType: z.enum(['FINANCIAL', 'ANALYTICS', 'USER_AUDIT']),
  userEmail: z.string().email(),
  filters: z.record(z.unknown()).optional().default({}),
  idempotencyKey: z.string().min(1),
  simulateFailure: z.boolean().optional().default(false),
  delayMs: z.number().nonnegative().optional().default(0),
});

export type ReportJobData = z.infer<typeof ReportJobDataSchema>;
export type ReportJobDataInput = z.input<typeof ReportJobDataSchema>;

export interface JobExecutionResult {
  success: boolean;
  jobName: JobName;
  idempotencyKey: string;
  processedAt: string;
  durationMs: number;
  data: Record<string, unknown>;
  isDuplicate?: boolean;
}
