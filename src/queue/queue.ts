import { Queue } from 'bullmq';
import { getProducerRedisOptions } from '../config/redis.connection.js';

export const TASK_QUEUE_NAME = 'task-processing-queue';

/**
 * Producer-side queue. Uses fail-fast connection options so an enqueue during a
 * Redis outage rejects immediately rather than buffering indefinitely.
 *
 * Retention is bounded on both axes (count and age) so a traffic burst cannot
 * grow Redis storage without limit.
 */
export const taskQueue = new Queue(TASK_QUEUE_NAME, {
  connection: getProducerRedisOptions(),
  defaultJobOptions: {
    removeOnComplete: { count: 20, age: 3600 },
    removeOnFail: { count: 100, age: 86400 },
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
  },
});
