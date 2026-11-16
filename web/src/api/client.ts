export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId: string | null,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

export type TokenSource = () => string | null;

let tokenSource: TokenSource = () => null;
let onUnauthenticated: (() => void) | null = null;

/** The session layer supplies the bearer token and reacts to 401 responses. */
export function configureApi(options: { token: TokenSource; onUnauthenticated: () => void }): void {
  tokenSource = options.token;
  onUnauthenticated = options.onUnauthenticated;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Overrides the session token, used by the onboarding wizard for bootstrap tokens. */
  token?: string | null;
  signal?: AbortSignal;
  /** Do not end the session on 401, used while validating a freshly entered key. */
  keepSession?: boolean;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = options.token === undefined ? tokenSource() : options.token;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      credentials: 'omit',
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
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === 'string') code = payload.error;
  } catch {
    // Non-JSON error bodies keep the generic code.
  }
  if (response.status === 401 && !options.keepSession && options.token === undefined) onUnauthenticated?.();
  throw new ApiError(response.status, code, requestId);
}
