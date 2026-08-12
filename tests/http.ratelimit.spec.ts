/**
 * HTTP intake rate limiting.
 *
 * Kept in its own spec file because the limiter keeps in-memory per-window state.
 * A low limit here would otherwise starve the other HTTP tests.
 *
 * Requests deliberately use an invalid payload: the limiter runs before the route
 * handler, so the counter still increments while nothing is enqueued to Redis.
 * This also demonstrates that a rejected request costs zero Redis commands.
 */
process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://allowed.example.com';
process.env.HTTP_RATE_LIMIT_MAX_PER_IP = '3';
process.env.HTTP_RATE_LIMIT_MAX_GLOBAL = '50';
process.env.HTTP_RATE_LIMIT_WINDOW_MS = '60000';
process.env.DASHBOARD_RATE_LIMIT_MAX_PER_IP = '4';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

const { buildApp } = await import('../src/app.js');
const { taskQueue } = await import('../src/queue/queue.js');
const { dlqQueue } = await import('../src/queue/dlq.js');
const { closeRedisConnection } = await import('../src/config/redis.connection.js');

let server: Server;
let baseUrl: string;

const INVALID_PAYLOAD = JSON.stringify({ to: 'not-an-email' });

async function postJob(forwardedFor?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (forwardedFor) {
    headers['X-Forwarded-For'] = forwardedFor;
  }
  return fetch(`${baseUrl}/api/jobs/email`, {
    method: 'POST',
    headers,
    body: INVALID_PAYLOAD,
  });
}

beforeAll(async () => {
  server = buildApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await taskQueue.close();
  await dlqQueue.close();
  await closeRedisConnection();
});

describe('Per-IP HTTP rate limiting', () => {
  it('returns 429 once the per-IP limit is exceeded', async () => {
    const clientIp = '203.0.113.10';
    const statuses: number[] = [];

    // Limit is 3; the fourth request in the window must be rejected.
    for (let i = 0; i < 4; i++) {
      statuses.push((await postJob(clientIp)).status);
    }

    expect(statuses.slice(0, 3)).toEqual([400, 400, 400]);
    expect(statuses[3]).toBe(429);
  });

  it('returns a generic message body on 429 with no internals', async () => {
    const clientIp = '203.0.113.11';
    for (let i = 0; i < 3; i++) {
      await postJob(clientIp);
    }

    const res = await postJob(clientIp);
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body).toEqual({ error: 'Too many requests. Please slow down.' });
  });

  /**
   * Proves Express `trust proxy` is wired correctly. Without it, req.ip would be
   * Render's load balancer address for every request, all clients would share one
   * bucket, and this second address would already be rate limited.
   */
  it('tracks distinct client IPs in separate buckets', async () => {
    const exhaustedIp = '203.0.113.20';
    for (let i = 0; i < 4; i++) {
      await postJob(exhaustedIp);
    }
    expect((await postJob(exhaustedIp)).status).toBe(429);

    const freshIp = '203.0.113.21';
    expect((await postJob(freshIp)).status).toBe(400);
  });

  it('advertises standard rate limit headers', async () => {
    const res = await postJob('203.0.113.30');
    expect(res.headers.get('ratelimit-limit') ?? res.headers.get('ratelimit')).toBeTruthy();
  });
});

/**
 * The public dashboard's snapshot cache bounds the polled route, but job-detail
 * routes are deliberately uncached and therefore reach Redis on every request.
 * On an unauthenticated surface that is an amplification primitive, so it is
 * capped per IP.
 */
describe('Public dashboard rate limiting', () => {
  function getJobDetail(ip: string): Promise<Response> {
    return fetch(`${baseUrl}/admin/queues/api/queues/task-processing-queue/12345`, {
      headers: { 'X-Forwarded-For': ip },
      redirect: 'manual',
    });
  }

  it('caps sustained requests to uncached dashboard routes', async () => {
    const clientIp = '198.51.100.10';

    for (let i = 0; i < 4; i++) {
      await getJobDetail(clientIp);
    }

    const res = await getJobDetail(clientIp);
    expect(res.status).toBe(429);
  });

  it('keeps dashboard buckets separate from job intake buckets', async () => {
    // A visitor browsing the dashboard must not consume the allowance that lets
    // them dispatch a job from the demo page, and vice versa.
    const clientIp = '198.51.100.11';

    for (let i = 0; i < 5; i++) {
      await getJobDetail(clientIp);
    }
    expect((await getJobDetail(clientIp)).status).toBe(429);

    // Job intake for the same IP is untouched: 400 is schema rejection, not 429.
    expect((await postJob(clientIp)).status).toBe(400);
  });
});
