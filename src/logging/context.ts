import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Request-scoped context, carried without threading an argument through every
 * call signature.
 *
 * The queue already logged `jobId`, but nothing connected a job back to the HTTP
 * request that created it: given a failed delivery in the DLQ there was no way
 * to find the intake request, and given a support report there was no way to
 * find the job. A correlation ID is the value that joins them.
 */
export interface RequestContext {
  correlationId: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** Header used to accept an inbound ID and to echo the resolved one. */
export const CORRELATION_HEADER = 'x-correlation-id';

/**
 * Normalises a caller-supplied correlation ID.
 *
 * An inbound ID is accepted so a caller can stitch its own trace to ours, but it
 * is never trusted as-is: it ends up in log lines, so an unbounded or
 * control-character-bearing value is a log-injection vector. Anything that does
 * not survive normalisation is discarded in favour of a fresh UUID rather than
 * being repaired into something that looks legitimate.
 */
export function normaliseCorrelationId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.trim().slice(0, 64).replace(/[^A-Za-z0-9_-]/g, '');
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Returns the current correlation ID, or undefined outside a request/job scope. */
export function getCorrelationId(): string | undefined {
  return requestContext.getStore()?.correlationId;
}

/** Runs `fn` inside a correlation scope. Used by the worker to re-enter one. */
export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return requestContext.run({ correlationId }, fn);
}

/**
 * Establishes a correlation scope for the lifetime of an HTTP request and echoes
 * the ID back, so a caller can quote it in a bug report.
 */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const correlationId = normaliseCorrelationId(req.get(CORRELATION_HEADER)) ?? randomUUID();
  res.setHeader(CORRELATION_HEADER, correlationId);
  requestContext.run({ correlationId }, next);
}
