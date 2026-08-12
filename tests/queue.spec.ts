import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { ZodError } from 'zod';
import { dispatchEmailJob, dispatchReportJob, resetQueueDepthCache } from '../src/queue/producer.js';
import { taskQueue } from '../src/queue/queue.js';
import { EmailJobDataSchema, ReportJobDataSchema } from '../src/types/job.types.js';
import { closeRedisConnection } from '../src/config/redis.connection.js';

describe('Queue Producer & Schema Validation', () => {
  afterEach(() => {
    resetQueueDepthCache();
  });

  afterAll(async () => {
    await taskQueue.close();
    await closeRedisConnection();
  });

  it('should successfully dispatch a valid email job', async () => {
    const payload = {
      to: 'test@example.com',
      subject: 'Welcome to Production Queue',
      body: 'Hello World',
      idempotencyKey: `idemp_email_${Date.now()}`,
    };

    const job = await dispatchEmailJob(payload);
    expect(job).toBeDefined();
    expect(job.id).toBe(`email_${payload.idempotencyKey}`);
    expect(job.data.to).toBe('test@example.com');
  });

  it('should reject invalid email payloads via Zod validation', async () => {
    const invalidPayload = {
      to: 'not-an-email',
      subject: '',
      body: 'Body',
      idempotencyKey: '',
    };

    await expect(dispatchEmailJob(invalidPayload as never)).rejects.toThrow(ZodError);
  });

  it('should successfully dispatch a valid report job', async () => {
    const payload = {
      reportType: 'FINANCIAL' as const,
      userEmail: 'finance@example.com',
      filters: { year: 2026 },
      idempotencyKey: `idemp_report_${Date.now()}`,
    };

    const job = await dispatchReportJob(payload);
    expect(job).toBeDefined();
    expect(job.id).toBe(`report_${payload.idempotencyKey}`);
    expect(job.data.reportType).toBe('FINANCIAL');
  });

  it('should reject invalid report types', async () => {
    const invalidPayload = {
      reportType: 'UNKNOWN_TYPE',
      userEmail: 'user@example.com',
      idempotencyKey: 'key123',
    };

    await expect(dispatchReportJob(invalidPayload as never)).rejects.toThrow(ZodError);
  });

  /**
   * Regression guard. `simulateFailure` was a runtime API field that let any
   * caller force a job to fail, driving 3 retry attempts plus a DLQ write from a
   * single unauthenticated HTTP request. It has been removed from the system
   * entirely; payloads carrying it must be rejected as invalid input rather than
   * silently accepted with the field stripped.
   */
  describe('regression: simulateFailure is not an accepted API field', () => {
    it('rejects an email payload containing simulateFailure', () => {
      const result = EmailJobDataSchema.safeParse({
        to: 'test@example.com',
        subject: 'Subject',
        body: 'Body',
        idempotencyKey: 'key_1',
        simulateFailure: true,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(JSON.stringify(result.error.issues)).toContain('simulateFailure');
      }
    });

    it('rejects a report payload containing simulateFailure', () => {
      const result = ReportJobDataSchema.safeParse({
        reportType: 'FINANCIAL',
        userEmail: 'finance@example.com',
        idempotencyKey: 'key_2',
        simulateFailure: true,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(JSON.stringify(result.error.issues)).toContain('simulateFailure');
      }
    });

    it('rejects the artificial delayMs field', () => {
      const result = EmailJobDataSchema.safeParse({
        to: 'test@example.com',
        subject: 'Subject',
        body: 'Body',
        idempotencyKey: 'key_3',
        delayMs: 60000,
      });

      expect(result.success).toBe(false);
    });

    it('rejects dispatch through the producer when simulateFailure is present', async () => {
      await expect(
        dispatchEmailJob({
          to: 'test@example.com',
          subject: 'Subject',
          body: 'Body',
          idempotencyKey: `idemp_reject_${Date.now()}`,
          simulateFailure: true,
        } as never)
      ).rejects.toThrow(ZodError);
    });

    it('does not expose simulateFailure or delayMs on the parsed schema shape', () => {
      const parsed = EmailJobDataSchema.parse({
        to: 'test@example.com',
        subject: 'Subject',
        body: 'Body',
        idempotencyKey: 'key_4',
      });

      expect(parsed).not.toHaveProperty('simulateFailure');
      expect(parsed).not.toHaveProperty('delayMs');
    });
  });
});
