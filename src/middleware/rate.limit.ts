import rateLimit from 'express-rate-limit';
import { config } from '../config/environment.js';
import { logger } from '../logging/logger.js';

/**
 * HTTP intake limiting.
 *
 * Both limiters use express-rate-limit's default in-memory store. This is
 * intentional and must not be changed to a Redis store: the whole purpose is to
 * cap Redis consumption, and a Redis-backed limiter would spend Redis commands on
 * every request including the ones it rejects. A rejected request costs zero
 * Redis commands as implemented.
 *
 * In-memory state is per-process, which is correct for this single-instance
 * deployment. If the service is ever scaled to multiple instances, each instance
 * enforces its own budget and the effective ceiling multiplies by instance count.
 */

const rateLimitMessage = {
  error: 'Too many requests. Please slow down.',
};

/**
 * Per-client limiter. Relies on the framework's default key generator, which
 * resolves req.ip correctly for both IPv4 and IPv6 once Express `trust proxy` is
 * configured for Render's load balancer.
 */
export const perIpJobLimiter = rateLimit({
  windowMs: config.HTTP_RATE_LIMIT_WINDOW_MS,
  limit: config.HTTP_RATE_LIMIT_MAX_PER_IP,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: rateLimitMessage,
  handler: (req, res, _next, options) => {
    logger.warn({ ip: req.ip, path: req.path }, 'Per-IP rate limit exceeded');
    res.status(options.statusCode).json(rateLimitMessage);
  },
});

/**
 * Public dashboard ceiling.
 *
 * The snapshot cache bounds the cost of the polled route, but Bull Board's
 * job-detail routes (`/api/queues/:queueName/:jobId` and its logs/flow siblings)
 * are deliberately uncached - they are opened by a human, not a timer, and should
 * always show current state. That leaves them as the one dashboard path where each
 * request reaches Redis, which on an unauthenticated route is an amplification
 * primitive of exactly the kind that caused the original incident.
 *
 * The limit is generous relative to real use: a polling tab issues ~6 requests/min
 * and an actively clicking human perhaps 30, against a 120/min ceiling. It exists
 * to stop a script, not to inconvenience a visitor.
 */
export const dashboardLimiter = rateLimit({
  windowMs: config.HTTP_RATE_LIMIT_WINDOW_MS,
  limit: config.DASHBOARD_RATE_LIMIT_MAX_PER_IP,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: rateLimitMessage,
  handler: (req, res, _next, options) => {
    logger.warn({ ip: req.ip, path: req.path }, 'Dashboard rate limit exceeded');
    res.status(options.statusCode).json(rateLimitMessage);
  },
});

/**
 * Global intake ceiling. Bounds total accepted job submissions per window
 * regardless of source, so a distributed burst across many IPs still cannot
 * convert the free Redis tier into someone else's workload.
 */
export const globalJobLimiter = rateLimit({
  windowMs: config.HTTP_RATE_LIMIT_WINDOW_MS,
  limit: config.HTTP_RATE_LIMIT_MAX_GLOBAL,
  standardHeaders: false,
  legacyHeaders: false,
  message: rateLimitMessage,
  // A single fixed bucket for all callers. Validation is disabled because the
  // constant key is deliberate, not an accidental misuse of req.ip.
  keyGenerator: () => 'global',
  validate: false,
  handler: (req, res, _next, options) => {
    logger.warn({ path: req.path }, 'Global job intake ceiling reached');
    res.status(options.statusCode).json(rateLimitMessage);
  },
});
