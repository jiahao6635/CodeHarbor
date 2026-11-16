import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { GraphClient } from './codegraph.js';

export interface McpRepository {
  id: string;
  name: string;
  status: string;
  indexedCommit: string | null;
  indexedAt: string | null;
  stale: boolean;
  /** Internal only; null means no usable index has been published. */
  projectPath: string | null;
}

export interface McpDependencies<Principal> {
  authenticate(req: IncomingMessage): Promise<Principal | null>;
  /** This function must return only repositories this principal may read. */
  listRepositories(principal: Principal, signal?: AbortSignal): Promise<McpRepository[]>;
  /** Returns null both for an unknown repository and for one not authorized. */
  getRepository(principal: Principal, repoId: string, signal?: AbortSignal): Promise<McpRepository | null>;
  /** Existing single-process backend. */
  codegraph?: GraphClient;
  /** Alternative backend must perform the complete query and before/after authorization atomically with publication coordination. */
  remoteExplore?: (
    principal: Principal,
    repoId: string,
    query: string,
    signal: AbortSignal,
  ) => Promise<{ repository: McpRepository; result: string } | null>;
  /** Exact browser origins allowed to use the endpoint. Non-browser clients can omit Origin. */
  allowedOrigins?: string[];
  /** Exact Host values accepted by the endpoint; configure behind a reverse proxy. */
  allowedHosts: string[];
  onToolResult?: (
    req: IncomingMessage,
    event: { tool: string; outcome: 'success' | 'error'; repo_id?: string; query_hash?: string },
  ) => void;
}

function publicRepository(repo: McpRepository) {
  return {
    repo_id: repo.id,
    name: repo.name,
    status: repo.status,
    indexed_commit: repo.indexedCommit,
    indexed_at: repo.indexedAt,
    stale: repo.stale,
  };
}

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function toolError(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

function hasExactKeys(args: Record<string, unknown>, keys: string[]) {
  return Object.keys(args).every((key) => keys.includes(key));
}

function validRepoId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

function rpcError(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/** Creates a stateless MCP HTTP handler; never share a request's principal across clients. */
export function createMcpHandler<Principal>(deps: McpDependencies<Principal>) {
  if (!!deps.codegraph === !!deps.remoteExplore) throw new Error('Exactly one MCP query backend is required');
  return async (req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void> => {
    const host = req.headers.host;
    const origin = req.headers.origin;
    if (!host || !deps.allowedHosts.includes(host) || (origin && !deps.allowedOrigins?.includes(origin))) {
      rpcError(res, 403, 'Forbidden');
      return;
    }
    let principal: Principal | null;
    try {
      principal = await deps.authenticate(req);
    } catch {
      rpcError(res, 503, 'Authentication unavailable');
      return;
    }
    if (principal === null) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      rpcError(res, 401, 'Authentication required');
      return;
    }
    if (req.method !== 'POST') {
      rpcError(res, 405, 'Method not allowed');
      return;
    }
    const caller = principal;
    const server = new Server({ name: 'CodeHarbor', version: '0.1.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'list_repositories',
          description: 'List indexed repositories accessible to the current user.',
          inputSchema: {
            type: 'object',
            properties: {
              cursor: { type: 'string', pattern: '^[0-9]{1,9}$' },
              limit: { type: 'integer', minimum: 1, maximum: 100 },
            },
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true },
        },
        {
          name: 'get_repository_status',
          description: 'Get index status and revision of an accessible repository.',
          inputSchema: {
            type: 'object',
            properties: { repo_id: { type: 'string', maxLength: 128 } },
            required: ['repo_id'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true },
        },
        {
          name: 'codegraph_explore',
          description: 'Explore symbols and code relationships within one accessible indexed repository.',
          inputSchema: {
            type: 'object',
            properties: {
              repo_id: { type: 'string', maxLength: 128 },
              query: { type: 'string', minLength: 1, maxLength: 2000 },
            },
            required: ['repo_id', 'query'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const args = request.params.arguments ?? {};
      const allowed = ['list_repositories', 'get_repository_status', 'codegraph_explore'];
      const tool = allowed.includes(request.params.name) ? request.params.name : '<unknown>';
      let outcome: 'success' | 'error' = 'error';
      let authorizedRepo: string | undefined;
      const queryHash =
        request.params.name === 'codegraph_explore' && typeof args.query === 'string'
          ? createHash('sha256').update(args.query).digest('hex')
          : undefined;
      const success = (value: unknown) => {
        outcome = 'success';
        return textResult(value);
      };
      try {
        if (request.params.name === 'list_repositories') {
          if (
            !hasExactKeys(args, ['cursor', 'limit']) ||
            (args.cursor !== undefined && (typeof args.cursor !== 'string' || !/^[0-9]{1,9}$/.test(args.cursor))) ||
            (args.limit !== undefined &&
              (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100))
          )
            return toolError('Invalid arguments');
          const offset = args.cursor === undefined ? 0 : Number(args.cursor);
          const limit = args.limit === undefined ? 50 : (args.limit as number);
          const repositories = await deps.listRepositories(caller, extra.signal);
          if ((await deps.authenticate(req)) === null) return toolError('Authentication required');
          return success({
            repositories: repositories.slice(offset, offset + limit).map(publicRepository),
            next_cursor: offset + limit < repositories.length ? String(offset + limit) : null,
          });
        }
        if (request.params.name === 'get_repository_status') {
          if (!hasExactKeys(args, ['repo_id']) || !validRepoId(args.repo_id)) return toolError('Invalid arguments');
          const repo = await deps.getRepository(caller, args.repo_id, extra.signal);
          if ((await deps.authenticate(req)) === null) return toolError('Authentication required');
          if (!repo) return toolError('Repository not found');
          authorizedRepo = repo.id;
          return success(publicRepository(repo));
        }
        if (request.params.name === 'codegraph_explore') {
          if (
            !hasExactKeys(args, ['repo_id', 'query']) ||
            !validRepoId(args.repo_id) ||
            typeof args.query !== 'string' ||
            !args.query.trim() ||
            args.query.length > 2000
          )
            return toolError('Invalid arguments');
          const { repo_id: repoId, query } = args;
          if (deps.remoteExplore) {
            const response = await deps.remoteExplore(caller, repoId, query, extra.signal);
            if (!response) return toolError('Repository not found or index changed');
            authorizedRepo = response.repository.id;
            return success({ ...publicRepository(response.repository), result: response.result });
          }
          return await deps.codegraph!.withQuery(async (explore) => {
            // A call can wait behind an index publication; recheck the key after it acquires the lock.
            const current = await deps.authenticate(req);
            if (current === null) return toolError('Authentication required');
            const repo = await deps.getRepository(current, repoId, extra.signal);
            if (!repo) return toolError('Repository not found');
            authorizedRepo = repo.id;
            if (!repo.projectPath || !repo.indexedCommit) return toolError('Repository index is not available');
            const result = await explore(repo.projectPath, query, extra.signal, {
              repoId: repo.id,
              commit: repo.indexedCommit,
            });
            const confirmed = await deps.authenticate(req);
            if (confirmed === null) return toolError('Authentication required');
            const currentRepo = await deps.getRepository(confirmed, repoId, extra.signal);
            if (
              !currentRepo ||
              currentRepo.projectPath !== repo.projectPath ||
              currentRepo.indexedCommit !== repo.indexedCommit
            )
              return toolError('Repository not found or index changed');
            return success({ ...publicRepository(repo), result });
          }, extra.signal);
        }
        return toolError('Unknown tool');
      } catch {
        return toolError('Request failed or upstream unavailable');
      } finally {
        try {
          deps.onToolResult?.(req, {
            tool,
            outcome,
            ...(authorizedRepo ? { repo_id: authorizedRepo } : {}),
            ...(queryHash !== undefined ? { query_hash: queryHash } : {}),
          });
        } catch {
          /* Audit observers cannot alter a response. */
        }
      }
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: 64 * 1024,
    });
    res.once('close', () => {
      void server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch {
      await server.close().catch(() => {});
      if (!res.headersSent) rpcError(res, 500, 'Internal error');
    }
  };
}
