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
// Small enough to exhaust deliberately in a test. Production defaults to 60/min.
process.env.DASHBOARD_MAX_REFRESHES_PER_WINDOW = '10';
process.env.DASHBOARD_REFRESH_WINDOW_MS = '60000';

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

const {
  dashboardSnapshotCache,
  invalidateDashboardSnapshot,
  resetDashboardSnapshotCache,
  dashboardSnapshotCacheSize,
  setDashboardQueueNames,
  buildSnapshotKey,
  canonicalizeQuery,
} = await import('../src/middleware/dashboard.cache.js');

const QUEUE_NAMES = ['task-processing-queue', 'dlq-task-queue'];
setDashboardQueueNames(QUEUE_NAMES);

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
    // Echoes what the UPSTREAM handler was asked for. Bull Board builds its payload
    // from req.query, so these are what determine whether a cached body matches the
    // key it is stored under.
    res.status(upstreamStatus).json({
      queues: [],
      call: upstreamCalls,
      q: req.query.status ?? null,
      status: req.query.status ?? null,
      page: req.query.page ?? null,
      jobsPerPage: req.query.jobsPerPage ?? null,
      junk: req.query.junk ?? null,
    });
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
    for (let i = 0; i < 20; i += 1) {
      await fetch(`${baseUrl}/api/queues?status=active&junk=${i}`);
    }

    expect(dashboardSnapshotCacheSize()).toBeLessThanOrEqual(4);
  });
});

describe('Cache key canonicalization', () => {
  /**
   * The regression this suite exists for.
   *
   * The cache formerly keyed on `req.originalUrl` while the route check used
   * `req.path`, so a parameter Bull Board ignores entirely still produced a cache
   * miss and a full Redis rebuild. Measured against a real Redis: 20 identical
   * polls cost 0 commands, 20 polls with a rotating parameter cost 520. At the
   * per-IP dashboard limit that is enough to exhaust a 500K monthly allowance in
   * under three hours from one address, without tripping any limiter.
   *
   * Memory was already bounded by the entry ceiling. Cost was not, and cost is what
   * the whole cache exists to control - so it is asserted here directly.
   */
  it('does not rebuild for parameters Bull Board ignores', async () => {
    for (let i = 0; i < 20; i += 1) {
      await fetch(`${baseUrl}/api/queues?junk=${i}`);
    }

    expect(upstreamCalls).toBe(1);
    expect(dashboardSnapshotCacheSize()).toBe(1);
  });

  it('keeps unknown parameters from shadowing a real view', async () => {
    await fetch(`${baseUrl}/api/queues?status=active`);
    await fetch(`${baseUrl}/api/queues?status=active&cachebust=9`);

    expect(upstreamCalls).toBe(1);
  });

  it('still separates the views that genuinely differ', () => {
    const key = (q: Record<string, unknown>) => buildSnapshotKey(canonicalizeQuery(q, QUEUE_NAMES));
    const base = key({});

    expect(key({ status: 'failed' })).not.toBe(base);
    expect(key({ page: '2' })).not.toBe(base);
    expect(key({ jobsPerPage: '25' })).not.toBe(base);
    expect(key({ activeQueue: 'dlq-task-queue' })).not.toBe(base);
  });

  it('collapses values outside their allowed range onto the default view', () => {
    const key = (q: Record<string, unknown>) => buildSnapshotKey(canonicalizeQuery(q, QUEUE_NAMES));
    const base = key({});

    // Unbounded page numbers were the remaining way to mint keys at will.
    expect(key({ page: '99999' })).toBe(base);
    expect(key({ page: '-1' })).toBe(base);
    expect(key({ page: 'abc' })).toBe(base);
    expect(key({ jobsPerPage: '99999' })).toBe(base);
    expect(key({ jobsPerPage: '0' })).toBe(base);
    expect(key({ jobsPerPage: 'abc' })).toBe(base);
    expect(key({ status: 'not-a-status' })).toBe(base);
    expect(key({ activeQueue: 'no-such-queue' })).toBe(base);
  });

  it('treats a repeated parameter as a single value', () => {
    // Express parses `?status=active&status=active` into an array, which would
    // otherwise stringify into a key of its own.
    const key = (q: Record<string, unknown>) => buildSnapshotKey(canonicalizeQuery(q, QUEUE_NAMES));
    expect(key({ status: ['active', 'active'] })).toBe(key({ status: 'active' }));
  });

  it("preserves a visitor's own page-size choice", async () => {
    // The UI's page-size control is a free numeric input, so an unusual but sane
    // value is a real setting rather than an attack, and must be honoured.
    const body = (await (await fetch(`${baseUrl}/api/queues?jobsPerPage=15`)).json()) as {
      jobsPerPage: string;
    };

    expect(body.jobsPerPage).toBe('15');
  });

  /**
   * Cache poisoning, and the reason canonicalization has to rewrite the request
   * rather than only the key.
   *
   * Collapsing `?page=999` onto the page-1 key while still letting Bull Board build
   * a page-999 payload caches the wrong body under the right key. The next honest
   * visitor asking for page 1 is then served page 999 - empty, since nothing is
   * retained that deep - for a full TTL. One crafted URL would corrupt what every
   * subsequent viewer sees, which is worse than the Redis cost this cache exists to
   * control.
   */
  it('serves the view that was asked for, not one an earlier caller forced', async () => {
    await fetch(`${baseUrl}/api/queues?page=999`);
    const honest = (await (await fetch(`${baseUrl}/api/queues?page=1`)).json()) as {
      page: string;
    };

    expect(honest.page).toBe('1');
  });

  it('hands the upstream handler canonical parameters only', async () => {
    const body = (await (
      await fetch(`${baseUrl}/api/queues?page=999&jobsPerPage=99999&status=bogus&junk=1`)
    ).json()) as Record<string, unknown>;

    expect(body.page).toBe('1');
    expect(body.jobsPerPage).toBe('10');
    expect(body.status).toBeNull();
    expect(body.junk).toBeNull();
  });
});

describe('Global refresh budget', () => {
  /**
   * Canonicalizing the key bounds the key space; it does not bound how fast a
   * caller can sweep it. Job intake already had a global ceiling alongside its
   * per-IP one, and this is the dashboard's equivalent.
   */
  it('stops reaching Redis once the window budget is spent', async () => {
    // Ten distinct legitimate views exhausts the budget configured for this suite.
    for (let page = 1; page <= 10; page += 1) {
      await fetch(`${baseUrl}/api/queues?page=${page}`);
    }
    expect(upstreamCalls).toBe(10);

    // An eleventh distinct view must not reach Redis, whatever it costs the caller.
    const shed = await fetch(`${baseUrl}/api/queues?page=11`);

    expect(shed.status).toBe(503);
    expect(shed.headers.get('x-dashboard-snapshot')).toBe('SHED');
    expect(shed.headers.get('retry-after')).toBe('60');
    expect(upstreamCalls).toBe(10);
  });

  it('serves a stale snapshot rather than shedding when one exists', async () => {
    // Every poll is invalidated first, so each one would rebuild if allowed to.
    let lastRebuilt: unknown;
    let last: Response | undefined;

    for (let i = 0; i < 15; i += 1) {
      invalidateDashboardSnapshot();
      last = await fetch(`${baseUrl}/api/queues`);
      if (last.headers.get('x-dashboard-snapshot') === 'MISS') {
        lastRebuilt = await last.clone().json();
      }
    }

    expect(upstreamCalls).toBe(10);
    expect(last?.status).toBe(200);
    expect(last?.headers.get('x-dashboard-snapshot')).toBe('STALE');
    // Stale means old, not wrong: the newest snapshot of THIS view is served,
    // never another view's data dressed up as this one's.
    expect(await last?.json()).toEqual(lastRebuilt);
  });

  it('does not charge cache hits against the budget', async () => {
    for (let i = 0; i < 50; i += 1) {
      await fetch(`${baseUrl}/api/queues`);
    }

    expect(upstreamCalls).toBe(1);

    // The budget is untouched, so a genuinely new view still rebuilds.
    await fetch(`${baseUrl}/api/queues?status=failed`);
    expect(upstreamCalls).toBe(2);
  });
});
