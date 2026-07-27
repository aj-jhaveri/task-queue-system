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

let redisClientInstance: Redis | null = null;

export function getRedisConnection(): Redis {
  if (!redisClientInstance) {
    redisClientInstance = new Redis(redisOptions);

    redisClientInstance.on('connect', () => {
      logger.info('Connected to Redis server successfully');
    });

    redisClientInstance.on('error', (err) => {
      logger.error({ err }, 'Redis Connection Error');
    });
  }

  return redisClientInstance;
}

export async function closeRedisConnection(): Promise<void> {
  if (redisClientInstance) {
    await redisClientInstance.quit();
    redisClientInstance = null;
    logger.info('Redis connection closed gracefully');
  }
}
