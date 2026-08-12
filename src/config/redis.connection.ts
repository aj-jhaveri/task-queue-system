import { Redis, RedisOptions } from 'ioredis';
import { config } from './environment.js';
import { logger } from '../logging/logger.js';

/**
 * Reconnect backoff shared by every connection. The delay is capped so a Redis
 * outage produces a bounded, quiet retry cadence rather than a hot loop, and
 * repeated attempts are logged sparsely to avoid flooding the log pipeline.
 */
const MAX_RECONNECT_DELAY_MS = 3000;
const RECONNECT_LOG_EVERY = 20;

function boundedRetryStrategy(times: number): number {
  if (times === 1 || times % RECONNECT_LOG_EVERY === 0) {
    logger.warn({ attempt: times }, 'Redis reconnect in progress');
  }
  return Math.min(times * 200, MAX_RECONNECT_DELAY_MS);
}

/**
 * True when an ioredis error is ordinary connection churn. Upstash closes idle
 * sockets, so these are expected and must not be logged as errors.
 */
function isTransientConnectionError(err: unknown): boolean {
  const candidate = err as { code?: string; message?: string } | undefined;
  const code = candidate?.code ?? '';
  const msg = candidate?.message ?? '';
  return (
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    msg.includes('ECONNRESET') ||
    msg.includes('EPIPE') ||
    msg.includes('Connection is closed')
  );
}

export function getNormalizedRedisUrl(): string {
  let url = (config.REDIS_URL || '').trim();
  if (!url) return '';

  // Convert https:// REST URLs to rediss:// TCP TLS URLs
  if (url.startsWith('https://')) {
    url = url.replace('https://', 'rediss://');
  } else if (url.startsWith('http://')) {
    url = url.replace('http://', 'redis://');
  }

  // Upstash Cloud Redis ALWAYS requires TLS (rediss://)
  if (url.includes('upstash.io') && url.startsWith('redis://')) {
    url = url.replace('redis://', 'rediss://');
  }

  // Ensure port 6379 is specified for Upstash hosts if missing
  if (url.includes('upstash.io') && !url.includes(':6379') && !url.includes(':443')) {
    url = url.replace('.upstash.io', '.upstash.io:6379');
  }

  return url;
}

/**
 * Base connection options.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ for blocking connections.
 * BullMQ workers must keep ioredis' offline queue enabled so commands issued
 * during a brief reconnect are not lost mid-job.
 */
export function getRedisOptions(): RedisOptions {
  const normUrl = getNormalizedRedisUrl();
  if (normUrl) {
    try {
      const parsed = new URL(normUrl);
      const isTls = normUrl.startsWith('rediss://');
      return {
        host: parsed.hostname,
        port: parseInt(parsed.port || '6379', 10),
        username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
        password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
        family: 4,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        keepAlive: 10000,
        tls: isTls ? { rejectUnauthorized: false } : undefined,
        retryStrategy: boundedRetryStrategy,
      };
    } catch {
      // A URL parse error message embeds the offending URL, which contains the
      // Redis password. Never attach the original error or the raw value here.
      throw new Error(
        'REDIS_URL could not be parsed. Expected rediss://<user>:<password>@<host>:<port>. ' +
          'The value has been withheld from this message.'
      );
    }
  }
  return {
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD || undefined,
    family: 4,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    keepAlive: 10000,
    retryStrategy: boundedRetryStrategy,
  };
}

/**
 * Producer-side options: fail fast instead of buffering commands forever while
 * Redis is unreachable. Without this, `queue.add()` hangs during an outage and
 * the API request stalls until the client times out; with it, the enqueue
 * rejects immediately and the caller receives a clean 503.
 *
 * Deliberately NOT used for the Worker, whose blocking connection needs the
 * offline queue to survive Upstash's idle-socket resets.
 */
export function getProducerRedisOptions(): RedisOptions {
  return {
    ...getRedisOptions(),
    enableOfflineQueue: false,
  };
}

let redisClientInstance: Redis | null = null;

export function getRedisConnection(): Redis {
  if (!redisClientInstance) {
    const normUrl = getNormalizedRedisUrl();
    if (normUrl) {
      redisClientInstance = new Redis(normUrl, getRedisOptions());
    } else {
      redisClientInstance = new Redis(getRedisOptions());
    }

    redisClientInstance.on('connect', () => {
      logger.info('Connected to Redis server successfully');
    });

    redisClientInstance.on('error', (err: unknown) => {
      if (isTransientConnectionError(err)) {
        logger.debug('Redis client socket auto-reconnecting');
        return;
      }
      // Log only the message, never the error object: ioredis attaches connection
      // options (including the password) to some error shapes.
      logger.error(
        { errMessage: err instanceof Error ? err.message : 'Unknown Redis error' },
        'Redis connection error'
      );
    });
  }

  return redisClientInstance;
}

export async function closeRedisConnection(): Promise<void> {
  if (redisClientInstance) {
    const client = redisClientInstance;
    redisClientInstance = null;

    client.removeAllListeners('error');
    client.on('error', () => {}); // No-op during shutdown

    try {
      if (client.status !== 'end') {
        await client.quit();
      }
    } catch {
      client.disconnect();
    }
    logger.info('Redis connection closed gracefully');
  }
}
