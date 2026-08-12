import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Parses a comma-separated origin allowlist into a normalized array.
 * Wildcards are intentionally unsupported: CORS must be an explicit allowlist.
 */
function parseOriginList(raw: string): string[] {
  return raw
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter((origin) => origin.length > 0 && origin !== '*');
}

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Redis connection. REDIS_URL is the sole production connection variable.
  REDIS_URL: z.string().optional().default(''),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional().default(''),

  // BullMQ worker tuning. drainDelay/stalledInterval are load-bearing for the
  // Upstash command budget - see docs/security-remediation.md before changing.
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(50).default(5),
  WORKER_DRAIN_DELAY_SECONDS: z.coerce.number().int().positive().default(60),
  WORKER_STALLED_INTERVAL_MS: z.coerce.number().int().positive().default(300000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_DURATION_MS: z.coerce.number().int().positive().default(60000),

  // HTTP intake protection (in-memory only - never Redis-backed).
  HTTP_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  HTTP_RATE_LIMIT_MAX_PER_IP: z.coerce.number().int().positive().default(20),
  HTTP_RATE_LIMIT_MAX_GLOBAL: z.coerce.number().int().positive().default(200),
  JSON_BODY_LIMIT: z.string().default('16kb'),
  TRUST_PROXY_HOPS: z.coerce.number().int().nonnegative().default(1),

  // Queue safety ceiling, evaluated on demand at job submission only.
  MAX_QUEUE_DEPTH: z.coerce.number().int().positive().default(1000),
  QUEUE_DEPTH_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(5000),

  // Public dashboard budget controls. These are what make an unauthenticated,
  // always-on Bull Board affordable on Upstash's free tier - see
  // docs/design_decisions.md. DASHBOARD_SNAPSHOT_TTL_MS is the idle backstop, not
  // the perceived refresh rate: a dispatch or job completion invalidates the
  // snapshot immediately, so the board is fresh whenever anything is happening.
  // 15 minutes. One refresh costs a MEASURED 27 Redis commands across the two
  // registered queues (10 zcard + 6 llen + 4 lindex + 2 hexists + 2 hget + 2
  // evalsha), not the ~10 originally assumed. At a 5-minute backstop a single
  // permanently-open tab would cost ~233K/month, which is half the Upstash
  // allowance for a page nobody is looking at. At 15 minutes it is ~78K.
  //
  // Raising it costs nothing in perceived freshness: every state change this
  // system can observe - enqueue, completion, failure, DLQ routing - invalidates
  // the snapshot immediately, so the backstop only ever governs a queue where
  // nothing is happening.
  DASHBOARD_SNAPSHOT_TTL_MS: z.coerce.number().int().positive().default(900000),
  DASHBOARD_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(10),
  DASHBOARD_MAX_CACHE_ENTRIES: z.coerce.number().int().positive().default(64),
  DASHBOARD_RATE_LIMIT_MAX_PER_IP: z.coerce.number().int().positive().default(120),

  // Webhook delivery job. The demo's retry showcase performs a real HTTP request
  // against a loopback sink; clients choose a named destination, never a URL, so
  // this job type presents no SSRF surface.
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  // Admin boundary for Bull Board and /metrics.
  BULLBOARD_USER: z.string().optional().default(''),
  BULLBOARD_PASSWORD: z.string().optional().default(''),

  // Explicit CORS allowlist. Wildcards are stripped by parseOriginList.
  CORS_ALLOWED_ORIGINS: z
    .string()
    .optional()
    .default('https://slakedesign.com,https://www.slakedesign.com'),

  SQLITE_DB_PATH: z.string().default('./data/idempotency.db'),
});

const parsed = EnvironmentSchema.safeParse(process.env);

if (!parsed.success) {
  // Report which variables are invalid without echoing their values, so a
  // malformed REDIS_URL or password never reaches stderr or a log aggregator.
  const invalidKeys = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
  throw new Error(
    `Invalid environment configuration. Offending variables: ${invalidKeys.join(', ')}. ` +
      'Values are intentionally omitted from this message.'
  );
}

export type Environment = z.infer<typeof EnvironmentSchema> & {
  corsAllowedOrigins: string[];
  adminAuthConfigured: boolean;
  isExplicitDevelopment: boolean;
};

const base = parsed.data;

/**
 * True only when NODE_ENV is *explicitly* set to "development".
 *
 * Deliberately reads process.env rather than the parsed config, because the schema
 * defaults NODE_ENV to "development" when it is unset. Relying on that default
 * would fail open: a deployment that simply never sets NODE_ENV (which is easy to
 * do, since hosts inject PORT but not NODE_ENV) would serve /metrics without
 * authentication and would try to load the pino-pretty devDependency in production.
 * Anything other than an explicit "development" is therefore treated as deployed.
 */
const isExplicitDevelopment = process.env.NODE_ENV === 'development';

export const config: Environment = {
  ...base,
  corsAllowedOrigins: parseOriginList(base.CORS_ALLOWED_ORIGINS),
  adminAuthConfigured: base.BULLBOARD_USER.length > 0 && base.BULLBOARD_PASSWORD.length > 0,
  isExplicitDevelopment,
};

/**
 * Validates a Redis connection URL without ever surfacing its value.
 *
 * Exported as a pure function so it can be tested against malformed input without
 * reloading the config module. Every throw path is written so the message cannot
 * contain the URL, because the URL embeds the Redis password.
 */
export function validateRedisUrl(rawUrl: string): void {
  if (!rawUrl) {
    // Falls back to discrete host/port/password, which is valid for local dev.
    return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(
      rawUrl.replace(/^https:\/\//, 'rediss://').replace(/^http:\/\//, 'redis://')
    );
  } catch {
    // Deliberately does NOT include the cause: URL parse errors embed the input.
    throw new Error(
      'REDIS_URL is set but is not a parseable URL. Expected form: rediss://<user>:<password>@<host>:<port>. ' +
        'The value has been withheld from this message.'
    );
  }

  if (!['redis:', 'rediss:'].includes(parsedUrl.protocol)) {
    throw new Error(
      `REDIS_URL has unsupported protocol "${parsedUrl.protocol}". Expected redis: or rediss:.`
    );
  }

  if (!parsedUrl.hostname) {
    throw new Error('REDIS_URL is missing a hostname. The value has been withheld from this message.');
  }
}

/** Validates the REDIS_URL currently present in the environment. */
export function assertRedisConfigValid(): void {
  validateRedisUrl(config.REDIS_URL);
}
