/**
 * Snapshot cache tests.
 *
 * This middleware is the control that makes an unauthenticated, always-on Bull
 * Board affordable on a free Redis tier, so its behaviour is pinned directly
 * rather than inferred through Bull Board. The upstream handler here stands in for
 * Bull Board's queuesHandler and counts how many times it would have hit Redis,
 * which is the number the whole design exists to keep small.
 */
process.env.NODE_ENV = 'test';
process.env.DASHBOARD_SNAPSHOT_TTL_MS = '300000';
process.env.DASHBOARD_MAX_CACHE_ENTRIES = '4';

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

const {
  dashboardSnapshotCache,
  invalidateDashboardSnapshot,
  resetDashboardSnapshotCache,
  dashboardSnapshotCacheSize,
} = await import('../src/middleware/dashboard.cache.js');

/** Counts requests that reached the upstream handler, i.e. that would cost Redis. */
let upstreamCalls = 0;
let upstreamStatus = 200;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(dashboardSnapshotCache);

  app.get('/api/queues', (req, res) => {
    upstreamCalls += 1;
    res.status(upstreamStatus).json({ queues: [], call: upstreamCalls, q: req.query.status ?? null });
  });

  app.post('/api/queues', (_req, res) => {
    upstreamCalls += 1;
    res.status(200).json({ mutated: true });
  });

  app.get('/api/queues/some-queue/1', (_req, res) => {
    upstreamCalls += 1;
    res.status(200).json({ job: 1 });
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  resetDashboardSnapshotCache();
  upstreamCalls = 0;
  upstreamStatus = 200;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Snapshot caching', () => {
  it('reaches Redis on the first request and serves the second from memory', async () => {
    const first = await fetch(`${baseUrl}/api/queues`);
    const second = await fetch(`${baseUrl}/api/queues`);

    expect(first.headers.get('x-dashboard-snapshot')).toBe('MISS');
    expect(second.headers.get('x-dashboard-snapshot')).toBe('HIT');
    expect(upstreamCalls).toBe(1);
  });

  it('returns identical payloads from cache and origin', async () => {
    const first = await (await fetch(`${baseUrl}/api/queues`)).json();
    const second = await (await fetch(`${baseUrl}/api/queues`)).json();

    expect(second).toEqual(first);
  });

  it('decouples Redis cost from concurrent viewer count', async () => {
    // The scenario that exhausted the previous Upstash allowance: many viewers,
    // each polling. Twenty polls must still cost exactly one Redis read.
    await Promise.all(Array.from({ length: 20 }, () => fetch(`${baseUrl}/api/queues`)));

    expect(upstreamCalls).toBe(1);
  });

  it('never instructs browsers or CDNs to cache the response', async () => {
    // Freshness is enforced server-side via invalidation. A client-held copy would
    // survive that invalidation and keep showing stale counts after a dispatch.
    const res = await fetch(`${baseUrl}/api/queues`);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('caches each distinct view separately', async () => {
    await fetch(`${baseUrl}/api/queues?status=active`);
    await fetch(`${baseUrl}/api/queues?status=failed`);
    await fetch(`${baseUrl}/api/queues?status=active`);

    expect(upstreamCalls).toBe(2);
  });
});

describe('Event-driven invalidation', () => {
  it('goes back to Redis after queue state changes', async () => {
    await fetch(`${baseUrl}/api/queues`);
    expect(upstreamCalls).toBe(1);

    invalidateDashboardSnapshot();

    const res = await fetch(`${baseUrl}/api/queues`);
    expect(res.headers.get('x-dashboard-snapshot')).toBe('MISS');
    expect(upstreamCalls).toBe(2);
  });

  it('invalidates every cached view at once', async () => {
    await fetch(`${baseUrl}/api/queues?status=active`);
    await fetch(`${baseUrl}/api/queues?status=failed`);
    expect(upstreamCalls).toBe(2);

    invalidateDashboardSnapshot();

    await fetch(`${baseUrl}/api/queues?status=active`);
    await fetch(`${baseUrl}/api/queues?status=failed`);
    expect(upstreamCalls).toBe(4);
  });

  it('does not retain a snapshot captured before an in-flight invalidation', async () => {
    // A dispatch landing while a refresh is in flight must not leave the pre-event
    // snapshot cached, or the board would show stale counts for a whole TTL.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const slowApp = express();
    slowApp.use(dashboardSnapshotCache);
    slowApp.get('/api/queues', async (_req, res) => {
      upstreamCalls += 1;
      await gate;
      res.status(200).json({ stale: true });
    });

    const slowServer = slowApp.listen(0);
    await new Promise<void>((resolve) => slowServer.once('listening', () => resolve()));
    const slowUrl = `http://127.0.0.1:${(slowServer.address() as AddressInfo).port}`;

    try {
      const inFlight = fetch(`${slowUrl}/api/queues`);
      await new Promise((resolve) => setTimeout(resolve, 20));

      invalidateDashboardSnapshot();
      release();
      await inFlight;

      const after = await fetch(`${slowUrl}/api/queues`);
      expect(after.headers.get('x-dashboard-snapshot')).toBe('MISS');
    } finally {
      await new Promise<void>((resolve) => slowServer.close(() => resolve()));
    }
  });
});

describe('Time-based backstop', () => {
  it('refreshes once the idle TTL lapses', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    await fetch(`${baseUrl}/api/queues`);
    expect(upstreamCalls).toBe(1);

    vi.setSystemTime(Date.now() + 300_001);

    const res = await fetch(`${baseUrl}/api/queues`);
    expect(res.headers.get('x-dashboard-snapshot')).toBe('MISS');
    expect(upstreamCalls).toBe(2);
  });

  it('still serves from cache just before the TTL lapses', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    await fetch(`${baseUrl}/api/queues`);
    vi.setSystemTime(Date.now() + 299_000);

    const res = await fetch(`${baseUrl}/api/queues`);
    expect(res.headers.get('x-dashboard-snapshot')).toBe('HIT');
    expect(upstreamCalls).toBe(1);
  });
});

describe('Scope and safety', () => {
  it('does not cache non-GET requests', async () => {
    await fetch(`${baseUrl}/api/queues`, { method: 'POST' });
    await fetch(`${baseUrl}/api/queues`, { method: 'POST' });

    expect(upstreamCalls).toBe(2);
  });

  it('does not cache on-demand job detail routes', async () => {
    // Only the polled route is cached. Job detail is opened deliberately by a
    // human, is not on a timer, and should always reflect current state.
    await fetch(`${baseUrl}/api/queues/some-queue/1`);
    await fetch(`${baseUrl}/api/queues/some-queue/1`);

    expect(upstreamCalls).toBe(2);
  });

  it('does not cache error responses', async () => {
    // Caching a transient Redis failure would pin the outage in place for a full
    // TTL even after Redis recovered.
    upstreamStatus = 500;

    await fetch(`${baseUrl}/api/queues`);
    await fetch(`${baseUrl}/api/queues`);

    expect(upstreamCalls).toBe(2);
    expect(dashboardSnapshotCacheSize()).toBe(0);
  });

  it('bounds memory when the query-string key space is abused', async () => {
    // Cache keys include the query string, so the key space is attacker-influenced.
    for (let i = 0; i < 20; i += 1) {
      await fetch(`${baseUrl}/api/queues?status=active&junk=${i}`);
    }

    expect(dashboardSnapshotCacheSize()).toBeLessThanOrEqual(4);
  });
});
