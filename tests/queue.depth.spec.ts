/**
 * Queue-depth ceiling behaviour.
 *
 * The depth check is demand-driven: it runs only inside a job-submit call and is
 * memoized for a short TTL. There is intentionally no background poller, so these
 * tests drive it by calling the producer directly and stubbing the count.
 */
process.env.NODE_ENV = 'test';
process.env.MAX_QUEUE_DEPTH = '5';
process.env.QUEUE_DEPTH_CACHE_TTL_MS = '5000';

import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';

const { dispatchEmailJob, resetQueueDepthCache } = await import('../src/queue/producer.js');
const { taskQueue } = await import('../src/queue/queue.js');
const { closeRedisConnection } = await import('../src/config/redis.connection.js');
const { QueueDepthExceededError, QueueUnavailableError } = await import(
  '../src/errors/app.errors.js'
);

function validPayload(suffix: string) {
  return {
    to: 'user@example.com',
    subject: 'Depth Test',
    body: 'Body',
    idempotencyKey: `depth_${suffix}_${Date.now()}`,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetQueueDepthCache();
});

afterAll(async () => {
  await taskQueue.close();
  await closeRedisConnection();
});

describe('Queue depth safeguard', () => {
  it('rejects submission when pending depth is at the configured ceiling', async () => {
    vi.spyOn(taskQueue, 'getJobCounts').mockResolvedValue({
      waiting: 5,
      active: 0,
      delayed: 0,
    } as never);

    await expect(dispatchEmailJob(validPayload('at_limit'))).rejects.toBeInstanceOf(
      QueueDepthExceededError
    );
  });

  it('rejects submission when pending depth exceeds the ceiling', async () => {
    vi.spyOn(taskQueue, 'getJobCounts').mockResolvedValue({
      waiting: 3,
      active: 2,
      delayed: 4,
    } as never);

    await expect(dispatchEmailJob(validPayload('over_limit'))).rejects.toBeInstanceOf(
      QueueDepthExceededError
    );
  });

  it('exposes a 429 status and a non-internal public message', async () => {
    vi.spyOn(taskQueue, 'getJobCounts').mockResolvedValue({
      waiting: 99,
      active: 0,
      delayed: 0,
    } as never);

    try {
      await dispatchEmailJob(validPayload('status'));
      expect.unreachable('expected a QueueDepthExceededError');
    } catch (err) {
      expect(err).toBeInstanceOf(QueueDepthExceededError);
      const typed = err as InstanceType<typeof QueueDepthExceededError>;
      expect(typed.statusCode).toBe(429);
      expect(typed.publicMessage).not.toContain('99');
    }
  });

  it('accepts submission when below the ceiling', async () => {
    vi.spyOn(taskQueue, 'getJobCounts').mockResolvedValue({
      waiting: 1,
      active: 0,
      delayed: 0,
    } as never);

    const job = await dispatchEmailJob(validPayload('under_limit'));
    expect(job.id).toBeDefined();
  });

  it('memoizes the depth read instead of querying Redis per request', async () => {
    const spy = vi.spyOn(taskQueue, 'getJobCounts').mockResolvedValue({
      waiting: 0,
      active: 0,
      delayed: 0,
    } as never);

    await dispatchEmailJob(validPayload('cache_a'));
    await dispatchEmailJob(validPayload('cache_b'));
    await dispatchEmailJob(validPayload('cache_c'));

    // Three submissions inside one TTL window must cost a single depth read.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('surfaces a Redis outage as QueueUnavailableError rather than hanging', async () => {
    vi.spyOn(taskQueue, 'getJobCounts').mockRejectedValue(
      new Error('Stream isn\'t writeable and enableOfflineQueue options is false')
    );

    await expect(dispatchEmailJob(validPayload('outage'))).rejects.toBeInstanceOf(
      QueueUnavailableError
    );
  });

  it('does not leak the Redis connection string in the unavailable error message', async () => {
    vi.spyOn(taskQueue, 'getJobCounts').mockRejectedValue(
      new Error('connect ECONNREFUSED rediss://default:supersecret@fake.upstash.io:6379')
    );

    try {
      await dispatchEmailJob(validPayload('leak'));
      expect.unreachable('expected a QueueUnavailableError');
    } catch (err) {
      const typed = err as InstanceType<typeof QueueUnavailableError>;
      expect(typed.publicMessage).not.toContain('supersecret');
      expect(typed.publicMessage).not.toContain('upstash');
    }
  });
});
