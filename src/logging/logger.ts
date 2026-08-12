import pino from 'pino';
import { config } from '../config/environment.js';

/**
 * Strips credentials out of anything that looks like a connection URL, plus bare
 * `password=`/`token=` query parameters. Used as a last line of defence before an
 * arbitrary error message reaches the log pipeline, since ioredis and the WHATWG
 * URL parser both embed the full connection string (including the password) in
 * their error messages.
 */
export function redactSecrets(input: string): string {
  return input
    .replace(/(rediss?|https?):\/\/[^:/@\s]*:[^@\s]*@/gi, '$1://[REDACTED]@')
    .replace(/\b(password|token|apikey|api_key|secret)=([^&\s]+)/gi, '$1=[REDACTED]');
}

export const logger = pino({
  level: config.LOG_LEVEL,
  // pino-pretty is a devDependency, so it must only be loaded when NODE_ENV is
  // explicitly "development" - never as a fallback for an unset NODE_ENV.
  transport:
    config.isExplicitDevelopment
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
  base: {
    env: config.NODE_ENV,
  },
  // Defence in depth: even if a secret-bearing object is logged by accident,
  // these paths are censored before serialization.
  redact: {
    paths: [
      'REDIS_URL',
      '*.REDIS_URL',
      'redisUrl',
      '*.redisUrl',
      'password',
      '*.password',
      'BULLBOARD_PASSWORD',
      '*.BULLBOARD_PASSWORD',
      'authorization',
      '*.authorization',
      'req.headers.authorization',
      'req.headers.cookie',
      'headers.authorization',
    ],
    censor: '[REDACTED]',
  },
  formatters: {
    log(object) {
      // Scrub credential-bearing URLs from common free-text message fields.
      for (const key of ['errMessage', 'msg', 'reason', 'failedReason'] as const) {
        const value = (object as Record<string, unknown>)[key];
        if (typeof value === 'string') {
          (object as Record<string, unknown>)[key] = redactSecrets(value);
        }
      }
      return object;
    },
  },
});
