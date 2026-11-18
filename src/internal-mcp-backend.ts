import { randomUUID } from 'node:crypto';
import type { Authorization, Principal } from './authorization.js';
import { type GraphClient, withGraphToolQuery } from './codegraph.js';
import { type CodeGraphToolCall, type CodeGraphToolName, validCodeGraphToolCall } from './codegraph-tools.js';
import { type AuditEvent, hashQuery } from './http/context.js';
import { HttpError } from './http/errors.js';
import { internalRepository } from './http/views.js';
import type { InternalMcpBackend } from './internal-mcp.js';
import type { RepositoryRecord, StoreBackend } from './store.js';

type InternalTool = 'list_repositories' | 'get_repository_status' | CodeGraphToolName;
type Outcome = 'success' | 'error';

const REPO_ID = /^[A-Za-z0-9_-]{1,128}$/;

function isNotFound(error: unknown): boolean {
  return error instanceof HttpError && error.status === 404;
}

/** Backend for the private MCP socket; every tool call is audited exactly once. */
export function createInternalMcpBackend(deps: {
  store: StoreBackend;
  graph: GraphClient;
  authorization: Authorization;
  audit: (event: AuditEvent) => void;
}): InternalMcpBackend {
  const { store, graph, authorization, audit } = deps;

  async function principalFrom(authorization_: string): Promise<Principal> {
    const key = await authorization.authenticateBearer(authorization_);
    if (!key) throw new Error('Authentication required');
    return key;
  }

  function record(tool: InternalTool, outcome: Outcome, principal?: Principal, repoId?: string, query?: string) {
    audit({
      request_id: randomUUID(),
      method: 'POST',
      route: '/mcp',
      status: outcome === 'success' ? 200 : 400,
      tool,
      tool_outcome: outcome,
      ...(principal ? { subject: principal.owner, key_prefix: principal.prefix, authentication: 'api_key' } : {}),
      ...(principal && repoId && REPO_ID.test(repoId) ? { repo_id: repoId } : {}),
      ...(typeof query === 'string' ? { query_hash: hashQuery(query) } : {}),
    });
  }

  async function callTool(header: string, repoId: string, call: CodeGraphToolCall, signal: AbortSignal) {
    if (!validCodeGraphToolCall(call)) throw new Error('Invalid tool arguments');
    let principal: Principal | undefined;
    let outcome: Outcome = 'error';
    try {
      return await withGraphToolQuery(
        graph,
        async (queryTool) => {
          if (signal.aborted) throw new Error('Request cancelled');
          principal = await principalFrom(header);
          let repo: RepositoryRecord;
          try {
            repo = await authorization.queryVisible(principal, repoId, signal);
          } catch (error) {
            if (isNotFound(error)) return null;
            throw error;
          }
          if (!repo.path || !repo.commit) return null;
          const result = await queryTool(repo.path, call, signal, { repoId: repo.id, commit: repo.commit });
          if (signal.aborted) throw new Error('Request cancelled');
          const confirmed = await principalFrom(header);
          let current: RepositoryRecord;
          try {
            current = await authorization.queryVisible(confirmed, repoId, signal);
          } catch (error) {
            if (isNotFound(error)) return null;
            throw error;
          }
          if (signal.aborted || current.path !== repo.path || current.commit !== repo.commit) return null;
          outcome = 'success';
          return { repository: internalRepository(repo), result };
        },
        signal,
      );
    } finally {
      record(
        call.name,
        outcome,
        principal,
        repoId,
        call.name === 'codegraph_explore' && Object.keys(call.arguments).length === 1
          ? (call.arguments.query as string)
          : JSON.stringify(call),
      );
    }
  }

  return {
    callTool,
    async probe(signal) {
      await store.checkHealth();
      await graph.probe(signal);
      if (signal.aborted) throw new Error('Request cancelled');
      return true;
    },
    async authenticate(header) {
      return !!(await authorization.authenticateBearer(header));
    },
    async list(header, signal) {
      let principal: Principal | undefined;
      let outcome: Outcome = 'error';
      try {
        principal = await principalFrom(header);
        const repositories = await authorization.queryList(principal, signal);
        if (signal.aborted || !(await authorization.authenticateBearer(header)))
          throw new Error('Authentication required');
        outcome = 'success';
        return repositories.map(internalRepository);
      } finally {
        record('list_repositories', outcome, principal);
      }
    },
    async get(header, repoId, signal) {
      let principal: Principal | undefined;
      let outcome: Outcome = 'error';
      try {
        principal = await principalFrom(header);
        const repo = await authorization.queryVisible(principal, repoId, signal);
        if (signal.aborted || !(await authorization.authenticateBearer(header)))
          throw new Error('Authentication required');
        outcome = 'success';
        return internalRepository(repo);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      } finally {
        record('get_repository_status', outcome, principal, repoId);
      }
    },
    explore: (header, repoId, query, signal) =>
      callTool(header, repoId, { name: 'codegraph_explore', arguments: { query } }, signal),
  };
}
