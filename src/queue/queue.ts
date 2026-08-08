import { Queue } from 'bullmq';
import { getRedisOptions } from '../config/redis.connection.js';

export const TASK_QUEUE_NAME = 'task-processing-queue';

export const taskQueue = new Queue(TASK_QUEUE_NAME, {
  connection: getRedisOptions(),
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
