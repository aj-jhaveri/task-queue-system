import { Request, Response, NextFunction } from 'express';
import { config } from '../config/environment.js';
import { logger } from '../logging/logger.js';
import { metricsService } from '../metrics/metrics.service.js';

/**
 * Server-side snapshot cache for the public Bull Board data API.
 *
 * WHY THIS EXISTS
 *
 * The dashboard is unauthenticated by design, so its cost has to be bounded
 * structurally rather than by asking visitors to behave. Bull Board's UI polls a
 * single route - `GET /api/queues` - and one refresh of the overview costs a
 * MEASURED 26 Redis commands across the two registered queues: 10 `zcard` and
 * 6 `llen` for the per-state counts, 4 `lindex` and 2 `hget` for the visible jobs,
 * 2 `hexists` for paused state, and 2 `evalsha`.
 *
 * Uncached at the stock 5s interval that is ~18,700 commands/hour per open tab.
 * A forgotten tab is what exhausted the previous 500K/month Upstash allowance in
 * roughly three days.
 *
 * Measure this again rather than trusting the number if the registered queue count
 * changes: the cost scales with how many queues are on the overview.
 *
 * WHY THE KEY IS CANONICALIZED
 *
 * Caching on the raw request URL made the cache trivially bypassable. The route
 * check looks at `req.path`, which excludes the query string, so `/api/queues?junk=1`
 * was cacheable but keyed differently from `/api/queues` - and a client rotating a
 * meaningless parameter missed on every request while Bull Board ignored the
 * parameter entirely. Measured: 20 identical polls cost 0 Redis commands, while 20
 * polls with a rotating parameter cost 520. At the per-IP dashboard limit that is
 * ~3,100 commands/minute from a single address, which exhausts a 500K monthly
 * allowance in under three hours without ever tripping a limiter.
 *
 * The key is therefore built from only the four parameters Bull Board's API
 * actually reads - `activeQueue`, `status`, `page`, `jobsPerPage` - each validated
 * against what it is allowed to be. Unknown parameters are dropped, and
 * out-of-range values collapse onto their defaults, so the key space is bounded by
 * the views that genuinely exist rather than by what a caller can type.
 *
 * WHY THERE IS ALSO A GLOBAL CEILING
 *
 * Canonicalizing the key removes the unbounded bypass but not the bounded one: the
 * legitimate view space is still a few thousand distinct snapshots, and sweeping it
 * costs real commands. Job intake already has a global ceiling alongside its per-IP
 * one (`globalJobLimiter`); the dashboard had only per-IP. `refreshBudget` caps how
 * many snapshot REBUILDS all callers combined can trigger per window. Past the cap
 * the last good snapshot is served instead. For a public read-only board, briefly
 * stale counts are the right degraded mode - far better than converting a free
 * Redis tier into someone else's workload.
 *
 * WHAT THIS CHANGES
 *
 * Cost is decoupled from both viewer count and poll rate. Ten simultaneous
 * viewers cost exactly what one costs, and the UI is free to poll quickly for
 * responsiveness because polls are answered from memory.
 *
 * FRESHNESS IS NOT SACRIFICED
 *
 * The TTL is an idle backstop, not the refresh rate. `invalidateDashboardSnapshot()`
 * is called whenever queue state actually changes - a job dispatched, completed, or
 * failed - so the next poll after any real event goes to Redis and returns live
 * data. While the queue is idle nothing is changing, so serving a cached snapshot
 * is not a stale answer; it is the correct answer, obtained for free.
 *
 * A refresh costs a measured 26 Redis commands across the two queues, so the worst
 * case with the default 900s backstop is 96 refreshes/day (~2.5K commands/day,
 * ~75K/month) even with a tab open permanently - against ~13.5M/month uncached.
 */

interface SnapshotEntry {
  body: unknown;
  expiresAt: number;
  generation: number;
}

const snapshotCache = new Map<string, SnapshotEntry>();

/**
 * Monotonic counter bumped on every real queue mutation. Cached entries carry the
 * generation they were built under, so a single increment invalidates all of them
 * at once without walking the map.
 */
let currentGeneration = 0;

/** True when the path is Bull Board's pollable data API. */
function isCacheableDataRoute(path: string): boolean {
  return path === '/api/queues';
}

/**
 * The only query parameters `@bull-board/api` reads on the queues route, verified
 * against the installed package rather than assumed. Anything else a caller sends
 * is ignored by the handler, so it must not influence the cache key either.
 */
const ALLOWED_STATUSES = new Set([
  'latest',
  'active',
  'waiting',
  'waiting-children',
  'completed',
  'failed',
  'delayed',
  'paused',
  'prioritized',
]);

/**
 * Bull Board's own default is `+query.jobsPerPage || 10`, which accepts any number
 * at all - including one large enough to pull an entire queue into a single
 * response. The UI's page-size control is a free numeric input rather than a fixed
 * set, so this is clamped to a range rather than snapped to a list: a visitor who
 * chooses 15 gets 15, and only absurd or non-numeric values are normalized.
 *
 * The key space this leaves is bounded but not small. That is deliberate - the hard
 * bound on cost is the global refresh budget below, and correctness for a real
 * visitor's chosen setting is worth more than a tighter key space.
 */
const MAX_JOBS_PER_PAGE = 100;
const DEFAULT_JOBS_PER_PAGE = 10;

/**
 * Page ceiling. The DLQ is the deepest queue at a 1,000-entry retention cap, which
 * is 100 pages at the default size. Beyond that there is nothing to show, so the
 * request is normalized onto the first page instead of minting a new snapshot.
 * A visitor using a small page size on a full DLQ could in principle reach past
 * this and be shown page 1; nothing at that depth is retained, so the practical
 * effect is nil.
 */
const MAX_PAGE = 100;

function firstValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  // Express parses a repeated parameter into an array. Take the first so that
  // `?status=active&status=active` cannot masquerade as a distinct view.
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

export interface CanonicalQuery {
  activeQueue?: string;
  status?: string;
  page: string;
  jobsPerPage: string;
}

/**
 * Reduces a request's query to validated values only.
 *
 * Every parameter is either recognised and echoed, or unrecognised and replaced by
 * its default. That is what makes the key space a function of the dashboard's real
 * views rather than of caller-supplied text, and it is the property the previous
 * `req.originalUrl` key lacked.
 *
 * `queueNames` is passed in rather than imported so the middleware stays testable
 * without standing up Bull Board, and so an unregistered queue name cannot mint a
 * snapshot for a queue that does not exist.
 */
export function canonicalizeQuery(
  query: Record<string, unknown>,
  queueNames: string[]
): CanonicalQuery {
  const rawQueue = firstValue(query.activeQueue);
  const activeQueue = rawQueue && queueNames.includes(rawQueue) ? rawQueue : undefined;

  const rawStatus = firstValue(query.status);
  const status = rawStatus && ALLOWED_STATUSES.has(rawStatus) ? rawStatus : undefined;

  const page = clampInt(firstValue(query.page), 1, MAX_PAGE, 1);

  const jobsPerPage = clampInt(
    firstValue(query.jobsPerPage),
    1,
    MAX_JOBS_PER_PAGE,
    DEFAULT_JOBS_PER_PAGE
  );

  return {
    ...(activeQueue ? { activeQueue } : {}),
    ...(status ? { status } : {}),
    page: String(page),
    jobsPerPage: String(jobsPerPage),
  };
}

/**
 * The cache key for a canonical query. One key per distinct view, and a view is
 * only distinct if the canonical parameters differ.
 */
export function buildSnapshotKey(canonical: CanonicalQuery): string {
  return `q=${canonical.activeQueue ?? ''}&s=${canonical.status ?? ''}&p=${canonical.page}&n=${canonical.jobsPerPage}`;
}

/**
 * Marks every cached snapshot stale. Called from the producer and the worker when
 * queue state genuinely changes, so the dashboard reflects real events promptly
 * without polling Redis on a timer.
 */
export function invalidateDashboardSnapshot(): void {
  currentGeneration += 1;
}

/**
 * Global ceiling on snapshot REBUILDS, counted across all callers rather than per
 * IP. A fixed window is sufficient here: the goal is a hard bound on Redis spend
 * per unit time, not smooth fairness between clients.
 */
const refreshBudget = { windowStart: 0, used: 0 };

/**
 * Consumes one unit of the global refresh budget.
 *
 * Returns false when the window is exhausted, which is the signal to serve a stale
 * snapshot rather than reach Redis.
 */
function claimRefreshBudget(now: number): boolean {
  if (now - refreshBudget.windowStart >= config.DASHBOARD_REFRESH_WINDOW_MS) {
    refreshBudget.windowStart = now;
    refreshBudget.used = 0;
  }
  if (refreshBudget.used >= config.DASHBOARD_MAX_REFRESHES_PER_WINDOW) {
    return false;
  }
  refreshBudget.used += 1;
  return true;
}

/** Test seam: drops all cached snapshots and resets the generation counter. */
export function resetDashboardSnapshotCache(): void {
  snapshotCache.clear();
  currentGeneration = 0;
  refreshBudget.windowStart = 0;
  refreshBudget.used = 0;
}

/** Test/diagnostic seam: number of snapshots currently held. */
export function dashboardSnapshotCacheSize(): number {
  return snapshotCache.size;
}

/**
 * The queue names a snapshot key is allowed to reference. Set once at app
 * construction from the queues actually registered with Bull Board.
 */
let registeredQueueNames: string[] = [];

export function setDashboardQueueNames(names: string[]): void {
  registeredQueueNames = names;
}

export function dashboardSnapshotCache(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'GET' || !isCacheableDataRoute(req.path)) {
    next();
    return;
  }

  // Bull Board varies the payload by queue/status/page, so those are part of the
  // identity of a snapshot - but ONLY those. Keying on the raw URL let any
  // unrecognised parameter mint a new key and force a Redis refresh; see the
  // canonicalization note at the top of this file.
  const canonical = canonicalizeQuery(req.query as Record<string, unknown>, registeredQueueNames);

  // Rewrite the request, not just the key. Collapsing `?page=999` onto the page-1
  // key while still letting Bull Board build a page-999 payload would cache the
  // wrong body under the right key, and the next honest visitor asking for page 1
  // would be served page 999 for a full TTL. Normalizing the query the adapter
  // reads keeps the cached body and its key describing the same view. The adapter
  // reads `req.query` and nothing else (verified in @bull-board/express), so this
  // is the only surface that needs it. defineProperty is used because Express
  // exposes `query` as a prototype getter.
  Object.defineProperty(req, 'query', {
    value: canonical,
    configurable: true,
    enumerable: true,
    writable: true,
  });

  const cacheKey = buildSnapshotKey(canonical);
  const now = Date.now();
  const cached = snapshotCache.get(cacheKey);

  if (cached && cached.expiresAt > now && cached.generation === currentGeneration) {
    metricsService.dashboardSnapshotTotal.inc({ source: 'cache' });
    res.setHeader('X-Dashboard-Snapshot', 'HIT');
    // Deliberately no-store: the freshness contract is enforced here, on the
    // server, where invalidation happens. A browser or CDN holding its own copy
    // would keep showing stale counts after a dispatch busts the snapshot.
    res.setHeader('Cache-Control', 'no-store');
    res.json(cached.body);
    return;
  }

  // A rebuild is about to reach Redis, so it has to fit inside the global budget.
  // Past the ceiling the cheapest honest answer is the stale snapshot for this
  // exact view; serving a different view's data to fake freshness would be worse
  // than admitting the data is old.
  if (!claimRefreshBudget(now)) {
    if (cached) {
      metricsService.dashboardSnapshotTotal.inc({ source: 'stale' });
      res.setHeader('X-Dashboard-Snapshot', 'STALE');
      res.setHeader('Cache-Control', 'no-store');
      res.json(cached.body);
      return;
    }

    // No prior snapshot for this view, so there is nothing truthful to serve
    // without reaching Redis. Refusing costs zero commands, which is the point.
    metricsService.dashboardSnapshotTotal.inc({ source: 'shed' });
    logger.warn(
      { cacheKey, windowMs: config.DASHBOARD_REFRESH_WINDOW_MS },
      'Dashboard refresh budget exhausted; shedding request'
    );
    res.setHeader('X-Dashboard-Snapshot', 'SHED');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', String(Math.ceil(config.DASHBOARD_REFRESH_WINDOW_MS / 1000)));
    res.status(503).json({ error: 'Dashboard is busy. Please retry shortly.' });
    return;
  }

  metricsService.dashboardSnapshotTotal.inc({ source: 'redis' });
  res.setHeader('X-Dashboard-Snapshot', 'MISS');
  res.setHeader('Cache-Control', 'no-store');

  // Capture the payload Bull Board is about to serialize. Patching res.json is
  // safe here because this branch is only reached on a miss, so the replacement
  // can never observe its own cache-hit write.
  const generationAtDispatch = currentGeneration;
  const originalJson = res.json.bind(res);

  res.json = (body: unknown): Response => {
    // Only successful payloads are worth retaining; caching an error response
    // would pin a transient Redis failure in place for the whole TTL.
    if (res.statusCode === 200) {
      if (snapshotCache.size >= config.DASHBOARD_MAX_CACHE_ENTRIES) {
        // The key space is now bounded by the validated parameter set rather than
        // by caller-supplied text, so reaching this ceiling means many real views
        // are in use rather than that someone is churning keys. Clearing wholesale
        // is O(1) amortized and keeps memory flat; the next few polls repopulate
        // the handful of views actually being looked at.
        snapshotCache.clear();
        logger.debug('Dashboard snapshot cache cleared at entry ceiling');
      }

      snapshotCache.set(cacheKey, {
        body,
        expiresAt: Date.now() + config.DASHBOARD_SNAPSHOT_TTL_MS,
        generation: generationAtDispatch,
      });
    }

    return originalJson(body);
  };

  next();
}
