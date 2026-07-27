import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional().default(''),
  WORKER_CONCURRENCY: z.coerce.number().default(5),
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  RATE_LIMIT_DURATION_MS: z.coerce.number().default(60000),
  SQLITE_DB_PATH: z.string().default('./data/idempotency.db'),
});

export type Environment = z.infer<typeof EnvironmentSchema>;

export const config: Environment = EnvironmentSchema.parse(process.env);
