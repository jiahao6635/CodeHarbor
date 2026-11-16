import pino, { type Logger } from 'pino';

export type { Logger };

/**
 * Process-wide structured logger. Secrets never belong in log fields: callers
 * pass identifiers (job id, repo id) and fixed messages, not tokens or queries.
 */
export function createLogger(options: { name: string; level?: string } = { name: 'codeharbor' }): Logger {
  return pino({ name: options.name, level: options.level ?? process.env.LOG_LEVEL ?? 'info' });
}
