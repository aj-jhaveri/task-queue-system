import { Request, Response, NextFunction } from 'express';
import { logger } from '../logging/logger.js';

/**
 * Hard read-only boundary for the public queue dashboard.
 *
 * `readOnlyMode: true` on the Bull Board adapters is NOT a security control. It
 * sets a flag the bundled UI reads to hide destructive buttons, but every mutating
 * handler is still mounted on the router: `POST /api/queues/:name/add`,
 * `PUT .../obliterate`, `PUT .../empty`, `PUT .../pause`, `PUT .../:jobId/retry`
 * and friends all remain reachable by anyone willing to issue the request by hand.
 * On an unauthenticated dashboard that is the difference between a demo and an
 * open write endpoint into the queue.
 *
 * Bull Board's entire read surface is GET, and every state-changing route is
 * POST/PUT/PATCH (see @bull-board/api routes.js), so refusing non-GET methods
 * outright removes the whole mutation surface without breaking any legitimate use.
 */
export function dashboardReadOnlyGuard(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD') {
    next();
    return;
  }

  logger.warn(
    { method: req.method, path: req.path, ip: req.ip },
    'Blocked mutating request to the read-only public dashboard'
  );

  res.setHeader('Allow', 'GET, HEAD');
  res.status(405).json({
    error: 'The queue dashboard is read-only. Queue state cannot be modified through this interface.',
  });
}

/**
 * Blocks Bull Board's Redis server-info route.
 *
 * `hideRedisDetails: true` only stops the UI from *requesting* /api/redis/stats;
 * the route still answers, and it returns raw `INFO` output - server version,
 * memory layout, client list, and uptime for the hosted Redis instance. That is
 * infrastructure detail with no place on a public page, and it costs a Redis
 * command per call, so it is refused rather than merely hidden.
 */
export function blockRedisStatsRoute(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/api/redis/stats') {
    res.status(404).json({ error: 'Not found.' });
    return;
  }
  next();
}
