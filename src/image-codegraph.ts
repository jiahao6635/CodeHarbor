/** The path is internal to every repository image, never supplied by an MCP client. */
import { ImageRuntimeRequestError } from './image-runtime-errors.js';
import { queryConcurrency } from './query-concurrency.js';

export const IMAGE_PROJECT_PATH = '/workspace/repo' as const;

export type ImageDigest = `sha256:${string}`;
export type ImageRepositoryIdentity = { repoId: string; commit: string };
export function validImageIdentity(identity: ImageRepositoryIdentity | undefined): identity is ImageRepositoryIdentity {
  return (
    !!identity &&
    typeof identity.repoId === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(identity.repoId) &&
    typeof identity.commit === 'string' &&
    /^[a-f0-9]{40,64}$/.test(identity.commit)
  );
}

/**
 * A restricted runtime service, separate from the public gateway and Docker socket.
 * close() must terminate all in-flight queries and containers before resolving.
 * explore() must not execute anything from the repository or expose the runtime to it.
 */
export interface ImageQueryBackend {
  explore(request: {
    digest: ImageDigest;
    repoId: string;
    commit: string;
    query: string;
    projectPath: typeof IMAGE_PROJECT_PATH;
    readOnlyRoot: true;
    signal: AbortSignal;
  }): Promise<string>;
  probe(signal: AbortSignal): Promise<void>;
  /** Fail-closed fence state, for monitoring; must never block on Docker. */
  status?(signal: AbortSignal): Promise<{ uncertain: boolean }>;
  close(): Promise<void>;
}

export function parseImageReference(reference: string): ImageDigest {
  const match = /^oci:\/\/(sha256:[a-f0-9]{64})$/.exec(reference);
  if (!match) throw new Error('Invalid repository image reference');
  return match[1] as ImageDigest;
}

/**
 * Allows bounded parallel queries; publication retains exclusive access.
 * The backend owns container operations; this class never receives a Docker socket.
 */
export class ImageCodeGraphClient {
  private readonly queue: Array<{ kind: 'read' | 'write'; run: () => void }> = [];
  private readers = 0;
  private writer = false;
  private unsafe = false;
  private failureDrain?: Promise<void>;

  constructor(
    private readonly backend: ImageQueryBackend,
    private readonly timeoutMs = 30_000,
    private readonly maxConcurrent = queryConcurrency(),
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid image query timeout');
    queryConcurrency(String(maxConcurrent));
  }

  private dispatch(): void {
    if (this.writer) return;
    while (this.queue.length) {
      const next = this.queue[0];
      if (next.kind === 'write') {
        if (this.readers) return;
        this.queue.shift();
        this.writer = true;
        next.run();
        return;
      }
      if (this.readers >= this.maxConcurrent) return;
      this.queue.shift();
      this.readers++;
      next.run();
    }
  }

  private schedule<T>(kind: 'read' | 'write', operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new Error('Request cancelled'));
    if (kind === 'read' && this.queue.filter((item) => item.kind === 'read').length >= 64)
      return Promise.reject(new Error('Image query queue is full'));
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1);
        signal?.removeEventListener('abort', abort);
        reject(new Error('Request cancelled'));
        this.dispatch();
      };
      const entry = {
        kind,
        run: () => {
          signal?.removeEventListener('abort', abort);
          void (async () => {
            try {
              resolve(await operation());
            } catch (error) {
              reject(error);
            } finally {
              if (kind === 'read') this.readers--;
              else this.writer = false;
              this.dispatch();
            }
          })();
        },
      };
      this.queue.push(entry);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      this.dispatch();
    });
  }

  private async closeBackend(): Promise<void> {
    const timer = AbortSignal.timeout(this.timeoutMs);
    try {
      await this.wait(() => this.backend.close(), timer);
    } catch {
      this.unsafe = true;
      throw new Error('Image runtime shutdown failed; restart required');
    }
  }

  private async wait<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw new Error('Request cancelled');
    let onAbort!: () => void;
    const abort = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('Request cancelled or timed out'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([operation(), abort]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private async query(
    reference: string,
    query: string,
    signal?: AbortSignal,
    identity?: ImageRepositoryIdentity,
  ): Promise<string> {
    if (this.unsafe) throw new Error('Image runtime shutdown failed; restart required');
    const digest = parseImageReference(reference);
    if (!validImageIdentity(identity)) throw new Error('Repository image identity required');
    if (typeof query !== 'string' || !query.trim() || query.length > 2000) throw new Error('Invalid query');
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      // The backend confirms per-request cleanup after cancellation before it settles.
      const result = await this.wait(
        () =>
          this.backend.explore({
            digest,
            ...identity,
            query,
            projectPath: IMAGE_PROJECT_PATH,
            readOnlyRoot: true,
            signal: combined,
          }),
        AbortSignal.timeout(this.timeoutMs + 30_000),
      );
      if (this.unsafe || combined.aborted) throw new ImageRuntimeRequestError('Request cancelled');
      if (typeof result !== 'string' || Buffer.byteLength(result, 'utf8') > 1024 * 1024)
        throw new Error('Invalid image query result');
      return result.split(IMAGE_PROJECT_PATH).join('[repository]').split(reference).join('[repository]');
    } catch (error) {
      // A confirmed request cleanup is isolated; uncertain transport loss fences the whole runtime.
      if (!(error instanceof ImageRuntimeRequestError)) {
        this.unsafe = true;
        this.failureDrain ??= this.closeBackend();
        await this.failureDrain;
      }
      throw error;
    }
  }

  async withQuery<T>(
    operation: (
      explore: (
        reference: string,
        query: string,
        signal?: AbortSignal,
        identity?: ImageRepositoryIdentity,
      ) => Promise<string>,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.schedule(
      'read',
      () => {
        if (this.unsafe) throw new Error('Image runtime shutdown failed; restart required');
        return operation((reference, query, signal, identity) => this.query(reference, query, signal, identity));
      },
      signal,
    );
  }

  async withExclusive<T>(
    operation: (
      explore: (
        reference: string,
        query: string,
        signal?: AbortSignal,
        identity?: ImageRepositoryIdentity,
      ) => Promise<string>,
    ) => Promise<T>,
  ): Promise<T> {
    return this.schedule('write', async () => {
      if (this.unsafe) throw new Error('Image runtime shutdown failed; restart required');
      await this.closeBackend();
      try {
        return await operation((reference, query, signal, identity) => this.query(reference, query, signal, identity));
      } finally {
        await this.closeBackend();
      }
    });
  }

  /** True once a backend shutdown failed; every query is refused until restart. */
  isUnsafe(): boolean {
    return this.unsafe;
  }

  /** Controller fence state; does not take a query slot. */
  async runtimeStatus(signal?: AbortSignal): Promise<{ uncertain: boolean }> {
    const status = this.backend.status?.bind(this.backend);
    if (!status) return { uncertain: false };
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return await this.wait(() => status(signal ? AbortSignal.any([signal, timeout]) : timeout), timeout);
  }

  async probe(signal?: AbortSignal): Promise<void> {
    await this.schedule(
      'read',
      async () => {
        if (this.unsafe) throw new Error('Image runtime shutdown failed; restart required');
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        await this.wait(() => this.backend.probe(combined), combined);
      },
      signal,
    );
  }

  async close(): Promise<void> {
    await this.withExclusive(async () => {});
  }
}
