export type CodeupErrorKind = 'invalid_credential' | 'forbidden' | 'not_found' | 'unavailable' | 'invalid_response';

export class CodeupError extends Error {
  constructor(public readonly kind: CodeupErrorKind, public readonly status?: number) {
    super(`Cloud DevOps request failed: ${kind}`);
    this.name = 'CodeupError';
  }
}

export type CodeupUser = { id: string; username: string; name: string };
export type CodeupRepository = {
  id: string;
  name: string;
  path: string;
  accessLevel: number | null;
  httpUrlToRepo?: string;
  defaultBranch?: string;
  cloneDownloadRestricted?: boolean;
};

type ClientOptions = {
  endpoint: string;
  organizationId?: string;
  /** Intended solely for local tests against a fake Codeup server. */
  allowHttp?: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CodeupError('invalid_response');
  return value as Record<string, unknown>;
}

function repository(value: unknown): CodeupRepository {
  const data = record(value);
  if (typeof data.id === 'number' && !Number.isSafeInteger(data.id)) throw new CodeupError('invalid_response');
  const id = String(data.id ?? '');
  if (!/^\d+$/.test(id) || typeof data.name !== 'string') throw new CodeupError('invalid_response');
  const rawLevel = data.accessLevel;
  const level = typeof rawLevel === 'number' || (typeof rawLevel === 'string' && /^\d+$/.test(rawLevel)) ? Number(rawLevel) : null;
  const cloneDownloadRestricted = data.enableCloneDownloadControl === true || data.openCloneDownloadControl === true
    ? true
    : data.enableCloneDownloadControl === false && data.openCloneDownloadControl === false ? false : undefined;
  return {
    id,
    name: data.name,
    path: typeof data.pathWithNamespace === 'string' ? data.pathWithNamespace : data.name,
    accessLevel: level,
    ...(typeof data.httpUrlToRepo === 'string' ? { httpUrlToRepo: data.httpUrlToRepo } : {}),
    ...(typeof data.defaultBranch === 'string' ? { defaultBranch: data.defaultBranch } : {}),
    ...(cloneDownloadRestricted !== undefined ? { cloneDownloadRestricted } : {}),
  };
}

/** A detail response proves visibility, not necessarily permission to clone. */
export function hasRepositoryRole(repo: CodeupRepository): boolean {
  return repo.accessLevel !== null && [20, 30, 40].includes(repo.accessLevel) && repo.cloneDownloadRestricted === false;
}

export class CodeupClient {
  private readonly endpoint: URL;
  private readonly repositoryRoot: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    const endpoint = new URL(options.endpoint);
    if ((endpoint.protocol !== 'https:' && !(options.allowHttp && endpoint.protocol === 'http:')) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
      throw new Error('Codeup endpoint must be a trusted HTTPS origin');
    }
    if (options.organizationId && !/^[A-Za-z0-9_-]+$/.test(options.organizationId)) throw new Error('Invalid organization ID');
    this.endpoint = endpoint;
    this.repositoryRoot = options.organizationId
      ? `/oapi/v1/codeup/organizations/${encodeURIComponent(options.organizationId)}`
      : '/oapi/v1/codeup';
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private async get(path: string, token: string): Promise<{ data: unknown; headers: Headers }> {
    if (!token || /[\r\n]/.test(token)) throw new CodeupError('invalid_credential');
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.endpoint), {
        headers: { 'x-yunxiao-token': token, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new CodeupError('unavailable');
    }
    if (!response.ok) {
      if (response.status === 401) throw new CodeupError('invalid_credential', response.status);
      if (response.status === 403) throw new CodeupError('forbidden', response.status);
      if (response.status === 404) throw new CodeupError('not_found', response.status);
      throw new CodeupError('unavailable', response.status);
    }
    try {
      return { data: await response.json(), headers: response.headers };
    } catch {
      throw new CodeupError('invalid_response', response.status);
    }
  }

  async getUser(token: string): Promise<CodeupUser> {
    const { data } = await this.get('/oapi/v1/platform/user', token);
    const user = record(data);
    if (typeof user.id !== 'string' || !user.id || typeof user.username !== 'string' || !user.username) {
      throw new CodeupError('invalid_response');
    }
    return { id: user.id, username: user.username, name: typeof user.name === 'string' ? user.name : user.username };
  }

  async listRepositories(token: string, page = 1, perPage = 100): Promise<{ repositories: CodeupRepository[]; nextPage: number | null }> {
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isInteger(perPage) || perPage < 1 || perPage > 100) throw new Error('Invalid pagination');
    const { data, headers } = await this.get(`${this.repositoryRoot}/repositories?page=${page}&perPage=${perPage}`, token);
    if (!Array.isArray(data)) throw new CodeupError('invalid_response');
    const next = headers.get('x-next-page');
    const total = headers.get('x-total-pages');
    if ((next && (!/^\d+$/.test(next) || !Number.isSafeInteger(Number(next)))) ||
        (total && (!/^\d+$/.test(total) || !Number.isSafeInteger(Number(total))))) throw new CodeupError('invalid_response');
    const nextPage = next ? Number(next) : null;
    const totalPages = total ? Number(total) : null;
    // Region can repeat the last page in x-next-page; total pages proves termination.
    if (totalPages !== null && ((nextPage !== null && nextPage > page && nextPage !== page + 1) ||
        (nextPage !== null && nextPage > totalPages) || (totalPages < page && data.length > 0) ||
        (totalPages > page && (nextPage === null || nextPage <= page)) ||
        (totalPages <= page && nextPage !== null && nextPage > page))) throw new CodeupError('invalid_response');
    if (nextPage !== null && nextPage <= page && (totalPages === null || totalPages > page)) throw new CodeupError('invalid_response');
    return { repositories: data.map(repository), nextPage: nextPage !== null && nextPage > page ? nextPage : null };
  }

  async getRepository(token: string, repoId: string): Promise<CodeupRepository> {
    if (!/^\d+$/.test(repoId)) throw new Error('Invalid repository ID');
    const { data } = await this.get(`${this.repositoryRoot}/repositories/${repoId}`, token);
    const repo = repository(data);
    if (repo.id !== repoId) throw new CodeupError('invalid_response');
    return repo;
  }

}
