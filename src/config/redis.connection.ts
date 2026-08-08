import { Redis, RedisOptions } from 'ioredis';
import { config } from './environment.js';
import { logger } from '../logging/logger.js';

export const redisOptions: RedisOptions = {
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  password: config.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy(times) {
    const delay = Math.min(times * 100, 3000);
    logger.warn({ times, delay }, 'Redis connection retrying...');
    return delay;
  },
};

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
        retryStrategy(times) {
          return Math.min(times * 200, 3000);
        },
      };
    } catch (e) {
      logger.error({ err: e }, 'Failed to parse REDIS_URL');
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
    retryStrategy(times) {
      return Math.min(times * 200, 3000);
    },
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

    redisClientInstance.on('error', (err: any) => {
      const code = err?.code || '';
      const msg = err?.message || '';
      if (
        code === 'ECONNRESET' ||
        code === 'EPIPE' ||
        msg.includes('ECONNRESET') ||
        msg.includes('EPIPE') ||
        msg.includes('Connection is closed')
      ) {
        logger.debug({ errMsg: msg }, 'Redis client socket auto-reconnecting');
        return;
      }
      logger.error({ err }, 'Redis Connection Error');
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
