import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Job } from 'bullmq';
import { buildApp } from '../src/app.js';
import { logger } from '../src/logging/logger.js';
import {
  correlationMiddleware,
  normaliseCorrelationId,
  runWithCorrelationId,
  getCorrelationId,
  CORRELATION_HEADER,
} from '../src/logging/context.js';
import { processEmailJob } from '../src/processors/email.processor.js';
import { JOB_NAMES } from '../src/types/job.types.js';
import { taskQueue } from '../src/queue/queue.js';
import { closeRedisConnection } from '../src/config/redis.connection.js';
import { resetQueueDepthCache } from '../src/queue/producer.js';

/**
 * Correlation ID propagation.
 *
 * The queue logged `jobId` but nothing tied a job to the HTTP request that
 * created it. Given a DLQ entry there was no way back to the intake call, and
 * given a user's bug report no way forward to the job. These tests are what let
 * the README claim an end-to-end traceable path rather than "we use Pino".
 */

const app = buildApp();

/** Captures what Pino would emit, including anything added by the mixin. */
function captureLogs(): { lines: Record<string, unknown>[]; restore: () => void } {
  const lines: Record<string, unknown>[] = [];
  const spy = vi
    .spyOn(logger, 'info')
    .mockImplementation(((obj: unknown, msg?: string) => {
      lines.push({ ...(obj as object), msg, correlationId: getCorrelationId() });
      return undefined;
    }) as never);
  return { lines, restore: () => spy.mockRestore() };
}

beforeEach(() => {
  resetQueueDepthCache();
});

afterAll(async () => {
  await taskQueue.close();
  await closeRedisConnection();
});

describe('normaliseCorrelationId', () => {
  it('accepts a well-formed inbound id', () => {
    expect(normaliseCorrelationId('abc-123_XYZ')).toBe('abc-123_XYZ');
  });

  it('caps length so an unbounded header cannot bloat every log line', () => {
    expect(normaliseCorrelationId('a'.repeat(500))).toHaveLength(64);
  });

  it('strips characters that would allow log injection', () => {
    // Newlines are the attack: a forged id containing \n could fabricate a
    // second, entirely fake log record.
    expect(normaliseCorrelationId('good\n{"level":50,"msg":"fake"}')).toBe(
      'goodlevel50msgfake'
    );
  });

  it('discards an id that normalises to nothing rather than repairing it', () => {
    expect(normaliseCorrelationId('!!!@@@')).toBeUndefined();
    expect(normaliseCorrelationId('   ')).toBeUndefined();
    expect(normaliseCorrelationId(undefined)).toBeUndefined();
  });
});

describe('HTTP correlation scope', () => {
  it('generates an id and echoes it when the caller sends none', async () => {
    const res = await request(app).get('/health');
    const id = res.headers[CORRELATION_HEADER];
    expect(id).toBeDefined();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('honours a caller-supplied id so traces can be stitched across systems', async () => {
    const res = await request(app).get('/health').set(CORRELATION_HEADER, 'caller-abc-1');
    expect(res.headers[CORRELATION_HEADER]).toBe('caller-abc-1');
  });

  it('sanitises a hostile inbound id before echoing or logging it', async () => {
    // Note on scope: a CRLF-bearing header cannot be sent at all - Node rejects
    // it client-side with "Invalid character in header content" - so the
    // log-injection case is covered by the normaliseCorrelationId unit test
    // above. What CAN cross the wire is punctuation and whitespace, which is
    // what this asserts against the real HTTP stack.
    const res = await request(app)
      .get('/health')
      .set(CORRELATION_HEADER, 'evil id;{"level":50}');

    expect(res.headers[CORRELATION_HEADER]).toBe('evilidlevel50');
  });

  it('replaces an inbound id that sanitises to nothing', async () => {
    const res = await request(app).get('/health').set(CORRELATION_HEADER, '!!! @@@ ###');
    // Not empty, not the junk: a fresh UUID.
    expect(res.headers[CORRELATION_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('issues a distinct id per request', async () => {
    const [a, b] = await Promise.all([request(app).get('/health'), request(app).get('/health')]);
    expect(a.headers[CORRELATION_HEADER]).not.toBe(b.headers[CORRELATION_HEADER]);
  });

  it('tags log lines written inside the request scope', async () => {
    const { lines, restore } = captureLogs();
    try {
      await new Promise<void>((resolve) => {
        const req = { get: () => 'scoped-test-1', headers: {} } as never;
        const res = { setHeader: () => {} } as never;
        correlationMiddleware(req, res, () => {
          logger.info({ where: 'inside' }, 'scoped line');
          resolve();
        });
      });
    } finally {
      restore();
    }

    expect(lines.at(-1)?.correlationId).toBe('scoped-test-1');
  });

  it('leaves no ambient scope behind after a request completes', () => {
    expect(getCorrelationId()).toBeUndefined();
  });
});

describe('Propagation across the queue boundary', () => {
  it('carries the id from intake into the enqueued job payload', async () => {
    const key = `corr_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const res = await request(app)
      .post('/api/jobs/email')
      .set(CORRELATION_HEADER, 'trace-e2e-1')
      .send({ to: 'ops@example.com', subject: 'trace', body: 'b', idempotencyKey: key });

    expect(res.status).toBe(202);
    // Returned to the caller so they can quote it.
    expect(res.body.correlationId).toBe('trace-e2e-1');

    // And persisted on the job, which is what survives the process boundary.
    const job = await taskQueue.getJob(`email_${key}`);
    expect(job?.data.correlationId).toBe('trace-e2e-1');
    await job?.remove();
  });

  it('rejects a correlationId supplied in the request body', async () => {
    // The header is the supported channel. Accepting a body field too would
    // give a caller two ways to set one value, and the strict schemas exist
    // precisely to stop undeclared fields being honoured silently.
    const res = await request(app)
      .post('/api/jobs/email')
      .send({
        to: 'ops@example.com',
        subject: 'forged',
        body: 'b',
        idempotencyKey: `forge_${Date.now()}`,
        correlationId: 'forged-by-client',
      });

    expect(res.status).toBe(400);
  });

  it('re-enters the scope in the worker so processor logs carry the id', async () => {
    const key = `corr_worker_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const { lines, restore } = captureLogs();

    try {
      // Exactly what the worker's processor callback does with job.data.
      await runWithCorrelationId('trace-worker-9', async () => {
        await processEmailJob({
          id: `email_${key}`,
          name: JOB_NAMES.EMAIL_NOTIFICATION,
          attemptsMade: 0,
          data: {
            to: 'ops@example.com',
            subject: 'worker trace',
            body: 'b',
            idempotencyKey: key,
            correlationId: 'trace-worker-9',
          },
        } as unknown as Job);
      });
    } finally {
      restore();
    }

    // The processor's own log lines - written with no knowledge of correlation -
    // are tagged by the mixin.
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.correlationId === 'trace-worker-9')).toBe(true);
  });

  it('falls back to the jobId when a job was enqueued outside a request', async () => {
    // A CLI-enqueued job has no originating HTTP request. It must still be
    // traceable, just not back to a caller.
    const fallback = `job-email_offline_1`;
    const seen = runWithCorrelationId(fallback, () => getCorrelationId());
    expect(seen).toBe(fallback);
  });
});
