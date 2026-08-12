import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { Job } from 'bullmq';
import { processEmailJob } from '../src/processors/email.processor.js';
import { processReportJob } from '../src/processors/report.processor.js';
import { getProcessorForJob } from '../src/processors/registry.js';
import { idempotencyDb } from '../src/storage/idempotency.db.js';
import { closeRedisConnection } from '../src/config/redis.connection.js';
import { taskQueue } from '../src/queue/queue.js';
import { dlqQueue, sendToDLQ } from '../src/queue/dlq.js';
import { WORKER_TUNING } from '../src/workers/task.worker.js';

describe('Worker Processor & Idempotency', () => {
  beforeEach(() => {
    idempotencyDb.clearAll();
    vi.restoreAllMocks();
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
      },
    } as Job<never>;

    const result = await processEmailJob(mockJob);

    expect(result.success).toBe(true);
    expect(result.idempotencyKey).toBe(key);
    expect(result.isDuplicate).toBeUndefined();

    expect(idempotencyDb.hasBeenProcessed(key)).toBe(true);
    expect(idempotencyDb.getRecord(key)?.status).toBe('COMPLETED');
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
      },
    } as Job<never>;

    const firstResult = await processEmailJob(mockJob);
    expect(firstResult.success).toBe(true);
    expect(firstResult.isDuplicate).toBeUndefined();

    const secondResult = await processEmailJob(mockJob);
    expect(secondResult.success).toBe(true);
    expect(secondResult.isDuplicate).toBe(true);
    expect(secondResult.durationMs).toBe(0);
  });

  /**
   * Failure injection is confined to the test suite.
   *
   * The application has no runtime switch for forcing a job to fail. To exercise
   * the real failure path, a genuine dependency error is induced with a mock, which
   * is what a real outage of the idempotency store would look like to the processor.
   */
  describe('genuine failure handling (test-only injection)', () => {
    it('propagates a real datastore error out of the email processor', async () => {
      const key = `test_real_failure_${Date.now()}`;
      vi.spyOn(idempotencyDb, 'recordSuccess').mockImplementation(() => {
        throw new Error('SQLITE_IOERR: disk I/O error');
      });

      const mockJob = {
        id: `email_${key}`,
        name: 'EMAIL_NOTIFICATION',
        attemptsMade: 0,
        data: {
          to: 'user@domain.com',
          subject: 'Failure Path',
          body: 'Body',
          idempotencyKey: key,
        },
      } as Job<never>;

      await expect(processEmailJob(mockJob)).rejects.toThrow('SQLITE_IOERR');
      expect(idempotencyDb.hasBeenProcessed(key)).toBe(false);
    });

    it('propagates a real datastore error out of the report processor', async () => {
      const key = `test_real_report_failure_${Date.now()}`;
      vi.spyOn(idempotencyDb, 'recordSuccess').mockImplementation(() => {
        throw new Error('SQLITE_BUSY: database is locked');
      });

      const mockJob = {
        id: `report_${key}`,
        name: 'REPORT_GENERATION',
        attemptsMade: 0,
        data: {
          reportType: 'ANALYTICS',
          userEmail: 'admin@domain.com',
          filters: {},
          idempotencyKey: key,
        },
      } as Job<never>;

      await expect(processReportJob(mockJob)).rejects.toThrow('SQLITE_BUSY');
      expect(idempotencyDb.hasBeenProcessed(key)).toBe(false);
    });

    it('rejects an unregistered job name at the registry boundary', () => {
      expect(() => getProcessorForJob('NOT_A_REAL_JOB')).toThrow(
        'No processor registered for job type: NOT_A_REAL_JOB'
      );
    });

    it('routes an exhausted job to the DLQ with the real failure reason', async () => {
      const key = `test_dlq_${Date.now()}`;
      const failedJob = {
        id: `report_${key}`,
        name: 'REPORT_GENERATION',
        attemptsMade: 3,
        data: { idempotencyKey: key, reportType: 'ANALYTICS' },
        stacktrace: [],
      } as unknown as Job;

      await sendToDLQ(failedJob, new Error('SQLITE_IOERR: disk I/O error'));

      const dlqJobs = await dlqQueue.getJobs(['waiting', 'active', 'completed', 'failed']);
      const routed = dlqJobs.find((job) => job?.data?.originalJobId === failedJob.id);

      expect(routed).toBeDefined();
      expect(routed?.data.failedReason).toContain('SQLITE_IOERR');
      expect(routed?.data.attemptsMade).toBe(3);
    });
  });

  /**
   * These two values are load-bearing for the Upstash free-tier command budget.
   * At BullMQ's defaults (5s / 30s) an idle worker costs ~37,440 commands/day,
   * which is ~225% of the 500K monthly cap before any job is submitted.
   * A silent regression here would reintroduce quota exhaustion, so it is pinned.
   */
  describe('worker Redis-budget configuration', () => {
    it('uses a 60 second drain delay', () => {
      expect(WORKER_TUNING.drainDelay).toBe(60);
    });

    it('uses a 300000 ms stalled check interval', () => {
      expect(WORKER_TUNING.stalledInterval).toBe(300000);
    });
  });
});
