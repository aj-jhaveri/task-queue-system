import { Request, Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import { config } from '../config/environment.js';
import { logger } from '../logging/logger.js';

/**
 * Constant-time credential comparison.
 *
 * Both values are SHA-256 hashed first so the buffers are always 32 bytes.
 * crypto.timingSafeEqual throws on length mismatch, so comparing raw secrets of
 * differing length would itself leak length information via the thrown error.
 */
function secureCompare(provided: string, expected: string): boolean {
  const providedHash = createHash('sha256').update(provided, 'utf8').digest();
  const expectedHash = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(providedHash, expectedHash);
}

function parseBasicAuth(header: string | undefined): { user: string; pass: string } | null {
  if (!header || !header.toLowerCase().startsWith('basic ')) {
    return null;
  }

  const encoded = header.slice(6).trim();
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return null;
  }

  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) {
    return null;
  }

  return {
    user: decoded.slice(0, separatorIndex),
    pass: decoded.slice(separatorIndex + 1),
  };
}

/**
 * HTTP Basic auth guard for the admin surface (Bull Board and /metrics).
 *
 * Fails closed: if BULLBOARD_USER/BULLBOARD_PASSWORD are not configured, the
 * guarded route is refused outright rather than served without protection.
 * Credential comparison is constant-time and both the username and password are
 * always evaluated, so a valid username cannot be discovered by response timing.
 */
export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.adminAuthConfigured) {
    logger.warn(
      { path: req.path },
      'Admin route refused: BULLBOARD_USER/BULLBOARD_PASSWORD are not configured'
    );
    res.status(503).json({ error: 'Admin interface is not configured on this deployment.' });
    return;
  }

  const credentials = parseBasicAuth(req.headers.authorization);

  if (!credentials) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Restricted", charset="UTF-8"');
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }

  // Evaluate both comparisons unconditionally to avoid short-circuit timing leaks.
  const userMatches = secureCompare(credentials.user, config.BULLBOARD_USER);
  const passMatches = secureCompare(credentials.pass, config.BULLBOARD_PASSWORD);

  if (!userMatches || !passMatches) {
    logger.warn({ path: req.path, ip: req.ip }, 'Rejected admin authentication attempt');
    res.setHeader('WWW-Authenticate', 'Basic realm="Restricted", charset="UTF-8"');
    res.status(401).json({ error: 'Invalid credentials.' });
    return;
  }

  next();
}
