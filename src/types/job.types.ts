import { z } from 'zod';

export const JOB_NAMES = {
  EMAIL_NOTIFICATION: 'EMAIL_NOTIFICATION',
  WEBHOOK_DELIVERY: 'WEBHOOK_DELIVERY',
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

/**
 * Public job schemas.
 *
 * These are `.strict()` on purpose. This system processes real work, so there is
 * no runtime switch for forcing artificial job failures or artificial delays.
 * Unknown keys are rejected rather than silently stripped, so a client sending a
 * removed field (for example `simulateFailure`) receives an explicit 400 instead
 * of a misleading 202 for a job that will not behave as the caller expects.
 *
 * Genuine failures still exercise the full retry -> exponential backoff -> DLQ
 * path; they originate from real processor errors, not from request input.
 */
export const EmailJobDataSchema = z
  .object({
    to: z.string().email(),
    subject: z.string().min(1).max(500),
    body: z.string().max(100_000),
    idempotencyKey: z.string().min(1).max(255),
  })
  .strict();

export type EmailJobData = z.infer<typeof EmailJobDataSchema>;
export type EmailJobDataInput = z.input<typeof EmailJobDataSchema>;

/**
 * Webhook delivery destinations.
 *
 * Callers select a NAMED destination; they never supply a URL. The name is mapped
 * to a concrete address server-side, which is what keeps this job type free of
 * SSRF surface - there is no input that can be pointed at cloud metadata endpoints,
 * internal services, or arbitrary third parties.
 *
 * `DEMO_UNAVAILABLE` targets a dependency that is genuinely unavailable, which is
 * how the retry demonstration stays honest. Nothing is simulated: the processor
 * performs a real HTTP request, the request really fails, and BullMQ's real retry,
 * exponential backoff, and DLQ routing handle it from there.
 */
export const WEBHOOK_DESTINATIONS = ['DEMO_AVAILABLE', 'DEMO_UNAVAILABLE'] as const;
export type WebhookDestination = (typeof WEBHOOK_DESTINATIONS)[number];

export const WebhookJobDataSchema = z
  .object({
    destination: z.enum(WEBHOOK_DESTINATIONS),
    event: z.string().min(1).max(200),
    payload: z.record(z.unknown()).optional().default({}),
    idempotencyKey: z.string().min(1).max(255),
  })
  .strict();

export type WebhookJobData = z.infer<typeof WebhookJobDataSchema>;
export type WebhookJobDataInput = z.input<typeof WebhookJobDataSchema>;

export interface JobExecutionResult {
  success: boolean;
  jobName: JobName;
  idempotencyKey: string;
  processedAt: string;
  durationMs: number;
  data: Record<string, unknown>;
  isDuplicate?: boolean;
}

/**
 * Correlation ID as it travels inside a job payload.
 *
 * Deliberately NOT part of the public input schemas above. Those stay strict
 * and correlationId-free, so a client that puts `correlationId` in a request
 * body gets a 400 rather than having it silently honoured - the same posture
 * this repo takes on `simulateFailure`. The supported way for a caller to
 * supply their own ID is the `x-correlation-id` request header, which is
 * normalised and length-capped by the correlation middleware.
 *
 * The producer stamps this field onto the payload AFTER validating client
 * input, so the value in a job is always server-resolved and cannot be forged
 * through the job body. Processors validate against the *Record schemas below,
 * which are the input schemas plus this one server-owned field.
 */
export const CorrelationIdSchema = z.string().min(1).max(64).optional();

export const EmailJobRecordSchema = EmailJobDataSchema.extend({
  correlationId: CorrelationIdSchema,
});

export const WebhookJobRecordSchema = WebhookJobDataSchema.extend({
  correlationId: CorrelationIdSchema,
});
