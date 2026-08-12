/**
 * Application error types that map to specific HTTP responses.
 * Each carries an explicit status so the error handler never has to guess, and
 * never has to echo an internal message to the client.
 */
export class QueueDepthExceededError extends Error {
  public readonly statusCode = 429;
  public readonly publicMessage = 'Queue is at capacity. Please retry shortly.';

  constructor(depth: number, limit: number) {
    super(`Queue depth ${depth} exceeds configured maximum of ${limit}`);
    this.name = 'QueueDepthExceededError';
  }
}

export class QueueUnavailableError extends Error {
  public readonly statusCode = 503;
  public readonly publicMessage = 'Queue backend is temporarily unavailable.';

  constructor(cause?: string) {
    super(cause ? `Queue backend unavailable: ${cause}` : 'Queue backend unavailable');
    this.name = 'QueueUnavailableError';
  }
}
