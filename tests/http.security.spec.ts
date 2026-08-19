/**
 * HTTP surface security tests.
 *
 * Environment is configured before the application modules are imported, because
 * config/environment.ts parses process.env once at module load. Vitest isolates
 * module state per spec file, so these values do not leak into other specs.
 */
process.env.NODE_ENV = 'test';
process.env.BULLBOARD_USER = 'admin-test-user';
process.env.BULLBOARD_PASSWORD = 'admin-test-password';
process.env.CORS_ALLOWED_ORIGINS = 'https://allowed.example.com';
process.env.HTTP_RATE_LIMIT_MAX_PER_IP = '500';
process.env.HTTP_RATE_LIMIT_MAX_GLOBAL = '1000';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

const { buildApp } = await import('../src/app.js');
const { taskQueue } = await import('../src/queue/queue.js');
const { dlqQueue } = await import('../src/queue/dlq.js');
const { closeRedisConnection } = await import('../src/config/redis.connection.js');

const ADMIN_USER = 'admin-test-user';
const ADMIN_PASSWORD = 'admin-test-password';
const ALLOWED_ORIGIN = 'https://allowed.example.com';
const DISALLOWED_ORIGIN = 'https://evil.example.com';

function basicAuthHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

let server: Server;
let baseUrl: string;

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

describe('Public service index', () => {
  it('advertises the public queue dashboard', async () => {
    const res = await fetch(`${baseUrl}/`);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain('/admin/queues');
  });

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`${baseUrl}/definitely-not-a-route`);
    expect(res.status).toBe(404);
  });
});

/**
 * The dashboard is intentionally public, so these tests pin the boundary that
 * replaced authentication: reads are open, writes are impossible.
 *
 * Every assertion here is deliberately reachable without a live Redis. The guard
 * runs ahead of Bull Board's handlers, so a rejected mutation never touches the
 * connection - which is also precisely why the guard is the right control.
 */
describe('Public read-only queue dashboard', () => {
  it('serves the dashboard without credentials', async () => {
    const res = await fetch(`${baseUrl}/admin/queues`, { redirect: 'manual' });
    expect(res.status).toBeLessThan(400);
  });

  it('does not demand authentication', async () => {
    const res = await fetch(`${baseUrl}/admin/queues`, { redirect: 'manual' });
    expect(res.status).not.toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it.each([
    ['POST', '/admin/queues/api/queues/task-processing-queue/add'],
    ['PUT', '/admin/queues/api/queues/task-processing-queue/obliterate'],
    ['PUT', '/admin/queues/api/queues/task-processing-queue/empty'],
    ['PUT', '/admin/queues/api/queues/task-processing-queue/pause'],
    ['PUT', '/admin/queues/api/queues/task-processing-queue/resume'],
    ['PUT', '/admin/queues/api/queues/task-processing-queue/clean/completed'],
    ['PUT', '/admin/queues/api/queues/task-processing-queue/retry/failed'],
    ['PUT', '/admin/queues/api/queues/task-processing-queue/1/retry'],
    ['PATCH', '/admin/queues/api/queues/task-processing-queue/1/update-data'],
    ['PUT', '/admin/queues/api/queues/pause'],
  ])('refuses %s %s with 405', async (method, path) => {
    const res = await fetch(`${baseUrl}${path}`, { method, redirect: 'manual' });

    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });

  it('refuses mutations even when valid admin credentials are supplied', async () => {
    // The dashboard is read-only as a property of the deployment, not a function
    // of who is asking. Nothing about this route should be unlockable over HTTP.
    const res = await fetch(
      `${baseUrl}/admin/queues/api/queues/task-processing-queue/obliterate`,
      {
        method: 'PUT',
        headers: { Authorization: basicAuthHeader(ADMIN_USER, ADMIN_PASSWORD) },
        redirect: 'manual',
      }
    );

    expect(res.status).toBe(405);
  });

  it('blocks the Redis server-info route', async () => {
    const res = await fetch(`${baseUrl}/admin/queues/api/redis/stats`, { redirect: 'manual' });
    expect(res.status).toBe(404);
  });

  it('does not leak Redis infrastructure detail from the blocked stats route', async () => {
    const res = await fetch(`${baseUrl}/admin/queues/api/redis/stats`, { redirect: 'manual' });
    const body = (await res.text()).toLowerCase();

    expect(body).not.toContain('redis_version');
    expect(body).not.toContain('upstash');
  });
});

describe('Metrics endpoint protection', () => {
  it('rejects unauthenticated access outside development', async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(401);
  });

  it('serves metrics to an authenticated admin', async () => {
    const res = await fetch(`${baseUrl}/metrics`, {
      headers: { Authorization: basicAuthHeader(ADMIN_USER, ADMIN_PASSWORD) },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('task_queue_');
  });
});

describe('CORS allowlist', () => {
  it('rejects a preflight from an unapproved origin', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/email`, {
      method: 'OPTIONS',
      headers: { Origin: DISALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });

    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('does not emit an allow-origin header for an unapproved origin', async () => {
    const res = await fetch(`${baseUrl}/health`, { headers: { Origin: DISALLOWED_ORIGIN } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('accepts a preflight from an approved origin', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/email`, {
      method: 'OPTIONS',
      headers: { Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
  });

  it('never responds with a wildcard allow-origin', async () => {
    const res = await fetch(`${baseUrl}/health`, { headers: { Origin: ALLOWED_ORIGIN } });
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
  });
});

describe('Job intake validation', () => {
  it('rejects a payload containing simulateFailure with 400', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: 'user@example.com',
        subject: 'Subject',
        body: 'Body',
        idempotencyKey: `http_sim_${Date.now()}`,
        simulateFailure: true,
      }),
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('simulateFailure');
  });

  it('rejects an unknown extra field with 400', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: 'user@example.com',
        subject: 'Subject',
        body: 'Body',
        idempotencyKey: `http_extra_${Date.now()}`,
        delayMs: 500000,
      }),
    });

    expect(res.status).toBe(400);
  });

  it('rejects malformed JSON with 400 and no stack trace', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"to": "broken",',
    });

    const body = await res.text();
    expect(res.status).toBe(400);
    expect(body).not.toContain('at Object');
    expect(body).not.toContain('node_modules');
  });

  it('accepts a valid email job payload', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: 'user@example.com',
        subject: 'Valid Subject',
        body: 'Valid body',
        idempotencyKey: `http_valid_${Date.now()}`,
      }),
    });

    const body = (await res.json()) as { status?: string; jobId?: string };
    expect(res.status).toBe(202);
    expect(body.status).toBe('QUEUED');
  });
});

describe('Webhook job intake', () => {
  it('accepts a named destination', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        destination: 'DEMO_UNAVAILABLE',
        event: 'demo.retry',
        idempotencyKey: `http_wh_${Date.now()}`,
      }),
    });

    const body = (await res.json()) as { status?: string; destination?: string };
    expect(res.status).toBe(202);
    expect(body.status).toBe('QUEUED');
    expect(body.destination).toBe('DEMO_UNAVAILABLE');
  });

  it('rejects a caller-supplied target URL with 400', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        destination: 'DEMO_AVAILABLE',
        event: 'demo',
        idempotencyKey: `http_wh_ssrf_${Date.now()}`,
        targetUrl: 'http://169.254.169.254/latest/meta-data/',
      }),
    });

    expect(res.status).toBe(400);
  });

  it('rejects an arbitrary destination with 400', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        destination: 'http://evil.example.com/hook',
        event: 'demo',
        idempotencyKey: `http_wh_bad_${Date.now()}`,
      }),
    });

    expect(res.status).toBe(400);
  });
});

describe('Webhook delivery sink', () => {
  it('accepts a delivery originating on loopback', async () => {
    const res = await fetch(`${baseUrl}/internal/webhook-sink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'demo' }),
    });

    expect(res.status).toBe(200);
  });

  it('refuses a delivery that arrived through the public proxy', async () => {
    // trust proxy is set to a hop count, so a forwarded request resolves to the
    // real client address rather than loopback and is refused.
    const res = await fetch(`${baseUrl}/internal/webhook-sink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' },
      body: JSON.stringify({ event: 'demo' }),
    });

    expect(res.status).toBe(403);
  });

  it('does not serve the unavailable destination', async () => {
    // The retry demo depends on this path genuinely not existing.
    const res = await fetch(`${baseUrl}/internal/webhook-sink/unavailable`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('Secret hygiene in responses', () => {
  it('does not leak credentials or connection strings in error bodies', async () => {
    const paths = ['/api/jobs/email', '/metrics', '/admin/queues', '/nope'];

    for (const path of paths) {
      const res = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
      const body = (await res.text()).toLowerCase();

      expect(body).not.toContain('rediss://');
      expect(body).not.toContain('upstash');
      expect(body).not.toContain(ADMIN_PASSWORD.toLowerCase());
    }
  });

  it('does not expose the x-powered-by header', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('sets baseline security headers', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBeTruthy();
  });
});
