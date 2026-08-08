import { Queue } from 'bullmq';
import { getRedisOptions } from '../config/redis.connection.js';

export const TASK_QUEUE_NAME = 'task-processing-queue';

export const taskQueue = new Queue(TASK_QUEUE_NAME, {
  connection: getRedisOptions(),
  defaultJobOptions: {
    removeOnComplete: 1000,
    removeOnFail: 5000,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
  },
});
