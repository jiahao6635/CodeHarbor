export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId: string | null,
    readonly data?: unknown,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

let onUnauthenticated: (() => void) | null = null;

export function configureApi(onExpired: () => void): () => void {
  onUnauthenticated = onExpired;
  return () => {
    if (onUnauthenticated === onExpired) onUnauthenticated = null;
  };
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  keepSession?: boolean;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'NETWORK_ERROR', null);
  }
  const requestId = response.headers.get('x-request-id');
  if (response.ok) {
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
  let code = 'INTERNAL_ERROR';
  let data: unknown;
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === 'string') code = payload.error;
    data = payload;
  } catch {
    // Non-JSON error bodies keep the generic code.
  }
  if (response.status === 401 && code === 'UNAUTHENTICATED' && !options.keepSession) onUnauthenticated?.();
  throw new ApiError(response.status, code, requestId, data);
}
