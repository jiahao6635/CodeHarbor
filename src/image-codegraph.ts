/** The path is internal to every repository image, never supplied by an MCP client. */
export const IMAGE_PROJECT_PATH = '/workspace/repo' as const;

export type ImageDigest = `sha256:${string}`;
export type ImageRepositoryIdentity = { repoId: string; commit: string };
export function validImageIdentity(identity: ImageRepositoryIdentity | undefined): identity is ImageRepositoryIdentity {
  return !!identity && typeof identity.repoId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(identity.repoId) &&
    typeof identity.commit === 'string' && /^[a-f0-9]{40,64}$/.test(identity.commit);
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
  close(): Promise<void>;
}

export function parseImageReference(reference: string): ImageDigest {
  const match = /^oci:\/\/(sha256:[a-f0-9]{64})$/.exec(reference);
  if (!match) throw new Error('Invalid repository image reference');
  return match[1] as ImageDigest;
}

/**
 * Serializes queries and publication, matching the existing CodeGraph lock semantics.
 * The backend owns container operations; this class never receives a Docker socket.
 */
export class ImageCodeGraphClient {
  private tail: Promise<void> = Promise.resolve();
  private unsafe = false;

  constructor(private readonly backend: ImageQueryBackend, private readonly timeoutMs = 30_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid image query timeout');
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
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
    try { return await Promise.race([operation(), abort]); }
    finally { signal.removeEventListener('abort', onAbort); }
  }

  private async query(reference: string, query: string, signal?: AbortSignal, identity?: ImageRepositoryIdentity): Promise<string> {
    if (this.unsafe) throw new Error('Image runtime shutdown failed; restart required');
    const digest = parseImageReference(reference);
    if (!validImageIdentity(identity)) throw new Error('Repository image identity required');
    if (typeof query !== 'string' || !query.trim() || query.length > 2000) throw new Error('Invalid query');
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const result = await this.wait(() => this.backend.explore({
        digest, ...identity, query, projectPath: IMAGE_PROJECT_PATH, readOnlyRoot: true, signal: combined,
      }), combined);
      if (typeof result !== 'string' || Buffer.byteLength(result, 'utf8') > 1024 * 1024) throw new Error('Invalid image query result');
      return result.split(IMAGE_PROJECT_PATH).join('[repository]').split(reference).join('[repository]');
    } catch (error) {
      // No later request may use a runtime with an abandoned container or handle.
      await this.closeBackend();
      throw error;
    }
  }

  async withQuery<T>(operation: (explore: (reference: string, query: string, signal?: AbortSignal, identity?: ImageRepositoryIdentity) => Promise<string>) => Promise<T>): Promise<T> {
    return this.serialized(() => {
      if (this.unsafe) throw new Error('Image runtime shutdown failed; restart required');
      return operation((reference, query, signal, identity) => this.query(reference, query, signal, identity));
    });
  }

  async withExclusive<T>(operation: (explore: (reference: string, query: string, signal?: AbortSignal, identity?: ImageRepositoryIdentity) => Promise<string>) => Promise<T>): Promise<T> {
    return this.serialized(async () => {
      if (this.unsafe) throw new Error('Image runtime shutdown failed; restart required');
      await this.closeBackend();
      try { return await operation((reference, query, signal, identity) => this.query(reference, query, signal, identity)); }
      finally { await this.closeBackend(); }
    });
  }

  async probe(): Promise<void> {
    await this.serialized(async () => {
      if (this.unsafe) throw new Error('Image runtime shutdown failed; restart required');
      const timeout = AbortSignal.timeout(this.timeoutMs);
      try { await this.wait(() => this.backend.probe(timeout), timeout); }
      catch (error) { await this.closeBackend(); throw error; }
    });
  }

  async close(): Promise<void> {
    await this.withExclusive(async () => {});
  }
}
