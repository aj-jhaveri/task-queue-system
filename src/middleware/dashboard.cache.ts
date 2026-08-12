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
 * single route - `GET /api/queues` - and each poll costs roughly 8-10 Redis
 * commands across the two registered queues (getJobCounts + isPaused +
 * getGlobalConcurrency per queue, plus getJobs for the visible tab).
 *
 * Uncached at the stock 5s interval that is ~5,000 commands/hour per open tab.
 * One tab left open for three days is ~360K commands on its own, which is what
 * exhausted the previous 500K/month Upstash allowance.
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
 * Worst case with the default 300s backstop is ~288 refreshes/day (~2.9K commands),
 * versus ~1.5M/month uncached.
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
 * Marks every cached snapshot stale. Called from the producer and the worker when
 * queue state genuinely changes, so the dashboard reflects real events promptly
 * without polling Redis on a timer.
 */
export function invalidateDashboardSnapshot(): void {
  currentGeneration += 1;
}

/** Test seam: drops all cached snapshots and resets the generation counter. */
export function resetDashboardSnapshotCache(): void {
  snapshotCache.clear();
  currentGeneration = 0;
}

/** Test/diagnostic seam: number of snapshots currently held. */
export function dashboardSnapshotCacheSize(): number {
  return snapshotCache.size;
}

export function dashboardSnapshotCache(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'GET' || !isCacheableDataRoute(req.path)) {
    next();
    return;
  }

  // Bull Board varies the payload by queue/status/page, so the query string is
  // part of the identity of a snapshot.
  const cacheKey = req.originalUrl;
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
        // The key space is driven by query parameters, so it is attacker-influenced.
        // Clearing wholesale is O(1) amortized and keeps memory flat; the next few
        // polls simply repopulate the handful of views actually in use.
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
