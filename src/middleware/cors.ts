import { Request, Response, NextFunction } from 'express';
import { config } from '../config/environment.js';
import { logger } from '../logging/logger.js';

const ALLOWED_METHODS = 'GET, POST, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, Authorization, X-Requested-With';

/**
 * Explicit-allowlist CORS.
 *
 * Replaces the previous `Access-Control-Allow-Origin: *`, which let any website
 * on the internet invoke the job-dispatch API from a visitor's browser.
 *
 * Requests without an Origin header (curl, server-to-server, uptime monitors) are
 * passed through untouched: CORS is a browser-enforced policy and is not a
 * substitute for authentication or rate limiting.
 */
export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;

  // Non-browser client: no Origin to validate, nothing to negotiate.
  if (!origin) {
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
      res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      res.status(204).end();
      return;
    }
    next();
    return;
  }

  const normalized = origin.replace(/\/$/, '');
  const isAllowed = config.corsAllowedOrigins.includes(normalized);

  if (!isAllowed) {
    logger.warn({ origin, path: req.path }, 'Blocked cross-origin request from unapproved origin');
    if (req.method === 'OPTIONS') {
      // Reject the preflight outright so the browser never issues the real request.
      res.status(403).json({ error: 'Origin not allowed.' });
      return;
    }
    // No Access-Control-Allow-Origin header is emitted, so the browser discards
    // the response. Non-preflight handling continues for non-browser callers.
    next();
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', normalized);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
  res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
  res.setHeader('Access-Control-Max-Age', '600');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
}
