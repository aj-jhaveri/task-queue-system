/**
 * Webhook delivery job tests.
 *
 * This job type exists so the public demo can show a genuine failure -> retry ->
 * backoff -> DLQ sequence without a simulation switch. These tests therefore pin
 * two things: that failures come from real HTTP outcomes, and that no client input
 * can influence where a request is sent.
 */
process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import type { Job } from 'bullmq';
import { JOB_NAMES } from '../src/types/job.types.js';

// Bind first so the sink can run on exactly the port the processor will resolve.
// Routes are registered after listen(), which Express supports, so there is no
// window in which the port is free for another process to take.
const sinkApp = express();
const sinkServer: Server = sinkApp.listen(0);
await new Promise<void>((resolve) => sinkServer.once('listening', () => resolve()));
const sinkPort = (sinkServer.address() as AddressInfo).port;
process.env.PORT = String(sinkPort);

const { WebhookJobDataSchema } = await import('../src/types/job.types.js');
const {
  processWebhookJob,
  resolveWebhookDestination,
  WEBHOOK_SINK_PATH,
  WEBHOOK_UNAVAILABLE_PATH,
} = await import('../src/processors/webhook.processor.js');
const { idempotencyDb } = await import('../src/storage/idempotency.db.js');

let sinkHits = 0;

beforeAll(() => {
  sinkApp.use(express.json());
  sinkApp.post(WEBHOOK_SINK_PATH, (_req, res) => {
    sinkHits += 1;
    res.status(200).json({ received: true });
  });
  // WEBHOOK_UNAVAILABLE_PATH is deliberately left unregistered.
});

afterAll(async () => {
  await new Promise<void>((resolve) => sinkServer.close(() => resolve()));
});

function buildJob(overrides: Record<string, unknown> = {}): Job {
  return {
    id: 'test-job',
    name: 'WEBHOOK_DELIVERY',
    attemptsMade: 0,
    data: {
      destination: 'DEMO_AVAILABLE',
      event: 'demo.dispatched',
      payload: {},
      idempotencyKey: `wh_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      ...overrides,
    },
  } as unknown as Job;
}

describe('Destination resolution', () => {
  it('maps named destinations onto loopback only', () => {
    for (const destination of ['DEMO_AVAILABLE', 'DEMO_UNAVAILABLE'] as const) {
      const url = resolveWebhookDestination(destination);
      expect(new URL(url).hostname).toBe('127.0.0.1');
    }
  });

  it('routes the two destinations to different paths', () => {
    expect(resolveWebhookDestination('DEMO_AVAILABLE')).toContain(WEBHOOK_SINK_PATH);
    expect(resolveWebhookDestination('DEMO_UNAVAILABLE')).toContain(WEBHOOK_UNAVAILABLE_PATH);
  });
});

describe('Schema hardening', () => {
  it('rejects a caller-supplied URL', () => {
    // The defence against SSRF is that no URL-shaped input exists at all.
    const result = WebhookJobDataSchema.safeParse({
      destination: 'DEMO_AVAILABLE',
      event: 'demo',
      idempotencyKey: 'k1',
      targetUrl: 'http://169.254.169.254/latest/meta-data/',
    });

    expect(result.success).toBe(false);
  });

  it('rejects an unknown destination', () => {
    const result = WebhookJobDataSchema.safeParse({
      destination: 'http://evil.example.com',
      event: 'demo',
      idempotencyKey: 'k2',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a simulateFailure switch', () => {
    const result = WebhookJobDataSchema.safeParse({
      destination: 'DEMO_UNAVAILABLE',
      event: 'demo',
      idempotencyKey: 'k3',
      simulateFailure: true,
    });

    expect(result.success).toBe(false);
  });

  it('accepts a well-formed payload', () => {
    const result = WebhookJobDataSchema.safeParse({
      destination: 'DEMO_AVAILABLE',
      event: 'demo.dispatched',
      idempotencyKey: 'k4',
    });

    expect(result.success).toBe(true);
  });
});

describe('Delivery against a reachable dependency', () => {
  it('performs a real HTTP request and succeeds', async () => {
    const before = sinkHits;
    const result = await processWebhookJob(buildJob());

    expect(sinkHits).toBe(before + 1);
    expect(result.success).toBe(true);
    expect(result.data.httpStatus).toBe(200);
  });

  it('short-circuits a duplicate idempotency key without re-delivering', async () => {
    const key = `wh_dup_${Date.now()}`;
    await processWebhookJob(buildJob({ idempotencyKey: key }));

    const before = sinkHits;
    const second = await processWebhookJob(buildJob({ idempotencyKey: key }));

    expect(second.isDuplicate).toBe(true);
    expect(sinkHits).toBe(before);
  });
});

describe('Delivery against an unavailable dependency', () => {
  it('throws on a genuine non-2xx response', async () => {
    await expect(
      processWebhookJob(buildJob({ destination: 'DEMO_UNAVAILABLE' }))
    ).rejects.toThrow(/rejected with HTTP 404/);
  });

  it('does not record a failed delivery as processed', async () => {
    // A failure must stay retryable. Recording it would make the retry a no-op
    // duplicate and silently break the backoff demonstration.
    const key = `wh_fail_${Date.now()}`;

    await expect(
      processWebhookJob(buildJob({ destination: 'DEMO_UNAVAILABLE', idempotencyKey: key }))
    ).rejects.toThrow();

    expect(idempotencyDb.hasBeenProcessed(JOB_NAMES.WEBHOOK_DELIVERY, key)).toBe(false);
  });

  it('surfaces a transport failure as a retryable error', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    await expect(processWebhookJob(buildJob())).rejects.toThrow(/transport level/);

    fetchSpy.mockRestore();
  });

  it('fails rather than hanging when the dependency does not respond', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(Object.assign(new Error('The operation was aborted'), {
        name: 'TimeoutError',
      }));

    await expect(processWebhookJob(buildJob())).rejects.toThrow(/transport level/);

    fetchSpy.mockRestore();
  });
});

/**
 * Cross-job-type idempotency collision.
 *
 * The idempotency table used to be keyed on `key` alone, and hasBeenProcessed()
 * ignored job_name even though the column existed. Clients pick their own
 * idempotency keys, and the producer prefixes BullMQ jobIds by type
 * (`email_<key>` / `webhook_<key>`), so two jobs sharing a business identifier
 * are distinct jobs that BOTH enqueue and BOTH reach a processor. The prefix is
 * what made the collision reachable, not what prevented it.
 *
 * The consequence was not a cosmetic wrong-return-value: the webhook
 * short-circuited before fetch(), so no HTTP request was made at all, and the
 * job reported success for a delivery that never happened. Silent delivery loss
 * counted as a success in both the API response and the metrics.
 */
describe('Idempotency is scoped by job type', () => {
  it('delivers a webhook whose key was already used by an email job', async () => {
    const sharedKey = `shared_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    // An email job completes first and writes its COMPLETED record.
    idempotencyDb.recordSuccess(sharedKey, JOB_NAMES.EMAIL_NOTIFICATION, {
      messageId: 'msg_from_email_job',
    });

    const before = sinkHits;
    const result = await processWebhookJob(
      buildJob({ destination: 'DEMO_AVAILABLE', idempotencyKey: sharedKey }) as never
    );

    // The invariant: the webhook must actually go out over the wire.
    expect(sinkHits).toBe(before + 1);
    expect(result.isDuplicate).toBeUndefined();
    expect(result.data).toMatchObject({ httpStatus: 200 });
    // And it must not have replayed the email job's payload.
    expect(JSON.stringify(result.data)).not.toContain('msg_from_email_job');
  });

  it('keeps both records independently under one shared key', () => {
    const sharedKey = `shared_rec_${Date.now()}`;

    idempotencyDb.recordSuccess(sharedKey, JOB_NAMES.EMAIL_NOTIFICATION, { side: 'email' });
    idempotencyDb.recordSuccess(sharedKey, JOB_NAMES.WEBHOOK_DELIVERY, { side: 'webhook' });

    // Under the legacy single-column key the second write would have
    // overwritten the first via ON CONFLICT(key).
    expect(idempotencyDb.getRecord(JOB_NAMES.EMAIL_NOTIFICATION, sharedKey)?.result_json)
      .toContain('email');
    expect(idempotencyDb.getRecord(JOB_NAMES.WEBHOOK_DELIVERY, sharedKey)?.result_json)
      .toContain('webhook');

    expect(idempotencyDb.hasBeenProcessed(JOB_NAMES.EMAIL_NOTIFICATION, sharedKey)).toBe(true);
    expect(idempotencyDb.hasBeenProcessed(JOB_NAMES.WEBHOOK_DELIVERY, sharedKey)).toBe(true);
  });

  it('still short-circuits a genuine same-type duplicate', async () => {
    const key = `dupe_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const first = await processWebhookJob(
      buildJob({ destination: 'DEMO_AVAILABLE', idempotencyKey: key }) as never
    );
    expect(first.isDuplicate).toBeUndefined();

    const before = sinkHits;
    const second = await processWebhookJob(
      buildJob({ destination: 'DEMO_AVAILABLE', idempotencyKey: key }) as never
    );

    // Scoping must not weaken same-type deduplication: no second delivery.
    expect(second.isDuplicate).toBe(true);
    expect(sinkHits).toBe(before);
  });
});
