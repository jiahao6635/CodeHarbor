import { randomUUID } from 'node:crypto';
import type { AuditRecord } from './store.js';

export type AuditInput = {
  request_id: string;
  method: string;
  route: string;
  status: number;
  authentication?: string;
  subject?: string;
  key_prefix?: string;
  repo_id?: string;
  tool?: string;
  tool_outcome?: string;
  /** SHA-256 of the code query: correlates repeated queries without storing their content. */
  query_hash?: string;
};

/**
 * Durable audit trail. Events are buffered and written in batches so a slow
 * database never delays a response; overflow is dropped and counted rather
 * than blocking, and the stdout log remains the secondary record.
 */
export class AuditWriter {
  private queue: AuditRecord[] = [];
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> = Promise.resolve();
  private closed = false;
  private droppedCount = 0;
  private failedCount = 0;

  constructor(
    private readonly store: { appendAuditEvents(rows: AuditRecord[]): Promise<void> },
    private readonly options: {
      maxQueued?: number;
      batchSize?: number;
      flushMs?: number;
      onError?: (error: unknown) => void;
    } = {},
  ) {}

  get dropped(): number {
    return this.droppedCount;
  }
  get failed(): number {
    return this.failedCount;
  }
  get pending(): number {
    return this.queue.length;
  }

  record(event: AuditInput): void {
    if (this.closed) {
      this.droppedCount++;
      return;
    }
    if (this.queue.length >= (this.options.maxQueued ?? 10_000)) {
      this.droppedCount++;
      return;
    }
    const preview = typeof event.query_hash === 'string' ? event.query_hash : null;
    this.queue.push({
      id: randomUUID(),
      at: Date.now(),
      request_id: String(event.request_id ?? ''),
      method: event.method,
      route: event.route,
      status: Number.isInteger(event.status) ? event.status : 0,
      authentication: event.authentication ?? null,
      subject: event.subject ?? null,
      key_prefix: event.key_prefix ?? null,
      repo_id: event.repo_id ?? null,
      tool: event.tool ?? null,
      tool_outcome: event.tool_outcome ?? null,
      query_hash: preview,
    });
    if (this.queue.length >= (this.options.batchSize ?? 200)) void this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.options.flushMs ?? 1000);
      this.timer.unref();
    }
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.flushing = this.flushing.then(async () => {
      while (this.queue.length) {
        const batch = this.queue.splice(0, this.options.batchSize ?? 200);
        try {
          await this.store.appendAuditEvents(batch);
        } catch (error) {
          this.failedCount += batch.length;
          try {
            this.options.onError?.(error);
          } catch {
            /* observers cannot throw */
          }
        }
      }
    });
    return this.flushing;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }
}
