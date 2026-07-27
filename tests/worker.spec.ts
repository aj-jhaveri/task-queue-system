import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { processEmailJob } from '../src/processors/email.processor.js';
import { processReportJob } from '../src/processors/report.processor.js';
import { idempotencyDb } from '../src/storage/idempotency.db.js';
import { closeRedisConnection } from '../src/config/redis.connection.js';
import { taskQueue } from '../src/queue/queue.js';
import { dlqQueue } from '../src/queue/dlq.js';
import { Job } from 'bullmq';

describe('Worker Processor & Idempotency Integration Tests', () => {
  beforeEach(() => {
    idempotencyDb.clearAll();
  });

  afterAll(async () => {
    idempotencyDb.clearAll();
    idempotencyDb.close();
    await taskQueue.close();
    await dlqQueue.close();
    await closeRedisConnection();
  });

  it('should process email job successfully and store idempotency record', async () => {
    const key = `test_idemp_email_${Date.now()}`;
    const mockJob = {
      id: `email_${key}`,
      name: 'EMAIL_NOTIFICATION',
      attemptsMade: 0,
      data: {
        to: 'user@domain.com',
        subject: 'Integration Test Email',
        body: 'Testing worker processing',
        idempotencyKey: key,
        simulateFailure: false,
        delayMs: 0,
      },
    } as Job<any>;

    const result = await processEmailJob(mockJob);

    expect(result.success).toBe(true);
    expect(result.idempotencyKey).toBe(key);
    expect(result.isDuplicate).toBeUndefined();

    // Verify SQLite record
    expect(idempotencyDb.hasBeenProcessed(key)).toBe(true);
    const dbRecord = idempotencyDb.getRecord(key);
    expect(dbRecord?.status).toBe('COMPLETED');
  });

  it('should block duplicate job processing via SQLite primary idempotency check', async () => {
    const key = `test_duplicate_${Date.now()}`;
    const mockJob = {
      id: `email_${key}`,
      name: 'EMAIL_NOTIFICATION',
      attemptsMade: 0,
      data: {
        to: 'user@domain.com',
        subject: 'First Execution',
        body: 'First body',
        idempotencyKey: key,
        simulateFailure: false,
        delayMs: 0,
      },
    } as Job<any>;

    // 1st Execution
    const firstResult = await processEmailJob(mockJob);
    expect(firstResult.success).toBe(true);
    expect(firstResult.isDuplicate).toBeUndefined();

    // 2nd Execution with same idempotencyKey
    const secondResult = await processEmailJob(mockJob);
    expect(secondResult.success).toBe(true);
    expect(secondResult.isDuplicate).toBe(true);
    expect(secondResult.durationMs).toBe(0);
  });

  it('should throw an error when simulateFailure is true', async () => {
    const key = `test_fail_${Date.now()}`;
    const mockJob = {
      id: `report_${key}`,
      name: 'REPORT_GENERATION',
      attemptsMade: 0,
      data: {
        reportType: 'ANALYTICS',
        userEmail: 'admin@domain.com',
        filters: {},
        idempotencyKey: key,
        simulateFailure: true,
        delayMs: 0,
      },
    } as Job<any>;

    await expect(processReportJob(mockJob)).rejects.toThrow('Simulated Report Processor failure');
    expect(idempotencyDb.hasBeenProcessed(key)).toBe(false);
  });
});
