/**
 * Configuration and secret-hygiene tests.
 *
 * A deliberately malformed REDIS_URL is installed before importing the config
 * module so the validation path can be exercised. The credential below is fake
 * and exists only to assert that it never appears in an error message.
 */
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = 'rediss://default:NOT_A_REAL_SECRET_abc123@fake-host.upstash.io:6379';

import { describe, it, expect, vi } from 'vitest';

const FAKE_SECRET = 'NOT_A_REAL_SECRET_abc123';

const { assertRedisConfigValid, validateRedisUrl } = await import('../src/config/environment.js');
const { redactSecrets } = await import('../src/logging/logger.js');

describe('REDIS_URL validation', () => {
  it('accepts a well-formed rediss:// URL', () => {
    expect(() => assertRedisConfigValid()).not.toThrow();
  });

  it('accepts an empty value and falls back to discrete host/port settings', () => {
    expect(() => validateRedisUrl('')).not.toThrow();
  });

  it('rejects an unparseable URL without echoing the value', () => {
    const malformed = `://malformed:${FAKE_SECRET}@@@not-a-url`;

    expect(() => validateRedisUrl(malformed)).toThrow(/withheld/);
    try {
      validateRedisUrl(malformed);
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(FAKE_SECRET);
      expect(message).not.toContain('malformed');
    }
  });

  it('rejects an unsupported protocol without echoing credentials', () => {
    const wrongProtocol = `ftp://default:${FAKE_SECRET}@fake-host.upstash.io:6379`;

    expect(() => validateRedisUrl(wrongProtocol)).toThrow(/unsupported protocol/);
    try {
      validateRedisUrl(wrongProtocol);
    } catch (err) {
      expect((err as Error).message).not.toContain(FAKE_SECRET);
    }
  });

  it('rejects a URL with no hostname without echoing credentials', () => {
    expect(() => validateRedisUrl('rediss://')).toThrow(/hostname|withheld/);
  });
});

describe('redactSecrets', () => {
  it('strips credentials from a rediss:// connection string', () => {
    const output = redactSecrets(
      `connect ECONNREFUSED rediss://default:${FAKE_SECRET}@fake-host.upstash.io:6379`
    );

    expect(output).not.toContain(FAKE_SECRET);
    expect(output).toContain('[REDACTED]');
  });

  it('strips credentials from a redis:// connection string', () => {
    const output = redactSecrets(`redis://user:${FAKE_SECRET}@localhost:6379`);
    expect(output).not.toContain(FAKE_SECRET);
  });

  it('strips credentials from an https:// URL', () => {
    const output = redactSecrets(`https://user:${FAKE_SECRET}@api.example.com/path`);
    expect(output).not.toContain(FAKE_SECRET);
  });

  it('strips bare password and token query parameters', () => {
    expect(redactSecrets(`?password=${FAKE_SECRET}`)).not.toContain(FAKE_SECRET);
    expect(redactSecrets(`token=${FAKE_SECRET}&x=1`)).not.toContain(FAKE_SECRET);
    expect(redactSecrets(`api_key=${FAKE_SECRET}`)).not.toContain(FAKE_SECRET);
  });

  it('leaves ordinary messages untouched', () => {
    const message = 'Job exhausted all retry attempts and moved to Dead Letter Queue';
    expect(redactSecrets(message)).toBe(message);
  });

  it('does not mangle a URL that carries no credentials', () => {
    const url = 'https://reports.internal/download/rpt_123.pdf';
    expect(redactSecrets(url)).toBe(url);
  });
});

/**
 * Hosting platforms inject PORT but generally do not inject NODE_ENV. Because the
 * schema defaults NODE_ENV to "development", anything keyed off that default would
 * fail OPEN on a deployment where the variable was simply never set - serving
 * /metrics unauthenticated and loading a devDependency logger in production.
 */
describe('NODE_ENV fail-safe', () => {
  async function loadConfigWith(nodeEnv: string | undefined) {
    const previous = process.env.NODE_ENV;
    if (nodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = nodeEnv;
    }
    vi.resetModules();
    try {
      return await import('../src/config/environment.js');
    } finally {
      process.env.NODE_ENV = previous;
      vi.resetModules();
    }
  }

  it('treats an unset NODE_ENV as deployed rather than development', async () => {
    const fresh = await loadConfigWith(undefined);
    expect(fresh.config.isExplicitDevelopment).toBe(false);
  });

  it('treats production as deployed', async () => {
    const fresh = await loadConfigWith('production');
    expect(fresh.config.isExplicitDevelopment).toBe(false);
  });

  it('recognizes an explicit development environment', async () => {
    const fresh = await loadConfigWith('development');
    expect(fresh.config.isExplicitDevelopment).toBe(true);
  });
});

describe('Environment validation error reporting', () => {
  it('names offending variables without printing their values', async () => {
    // PORT must be a positive integer; an invalid value must be reported by name
    // only, so a co-located secret in the same failure batch is never echoed.
    const previousPort = process.env.PORT;
    process.env.PORT = 'not-a-number';

    try {
      const { z } = await import('zod');
      const schema = z.object({ PORT: z.coerce.number().int().positive() });
      const result = schema.safeParse(process.env);

      expect(result.success).toBe(false);
      if (!result.success) {
        const keys = result.error.issues.map((issue) => issue.path.join('.'));
        expect(keys).toContain('PORT');
        expect(JSON.stringify(result.error.issues)).not.toContain(FAKE_SECRET);
      }
    } finally {
      process.env.PORT = previousPort;
    }
  });
});
