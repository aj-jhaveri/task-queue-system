import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { dispatchEmailJob, dispatchReportJob } from '../src/queue/producer.js';
import { taskQueue } from '../src/queue/queue.js';
import { closeRedisConnection } from '../src/config/redis.connection.js';
import { ZodError } from 'zod';

describe('Queue Producer & Schema Validation Unit Tests', () => {
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

    await expect(dispatchEmailJob(invalidPayload as any)).rejects.toThrow();
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

    await expect(dispatchReportJob(invalidPayload as any)).rejects.toThrow();
  });
});
