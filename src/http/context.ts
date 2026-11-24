import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { CredentialCipher } from '../auth.js';
import type { Authorization, Principal } from '../authorization.js';
import type { BrowserSession, BrowserSessionService, FeishuConfig } from '../browser-auth.js';
import type { GraphClient } from '../codegraph.js';
import type { CodeupClient } from '../codeup.js';
import type { IndexRequest } from '../indexer.js';
import type { RateLimiter } from '../rate-limit.js';
import type { StoreBackend } from '../store.js';
import type { IndexWorker } from '../worker.js';
import type { HttpMetrics } from './metrics.js';

export type AuditEvent = {
  request_id: string;
  method: string;
  route: string;
  status: number;
  authentication?: 'api_key' | 'feishu_session' | 'yunxiao_pat' | 'bootstrap' | 'webhook';
  subject?: string;
  key_prefix?: string;
  repo_id?: string;
  tool?: string;
  tool_outcome?: 'success' | 'error';
  /** SHA-256 of the code query; query content itself never enters audit records. */
  query_hash?: string;
};

export type AuditActor = Pick<
  AuditEvent,
  'subject' | 'key_prefix' | 'authentication' | 'repo_id' | 'tool' | 'tool_outcome' | 'query_hash'
>;

declare module 'fastify' {
  interface FastifyRequest {
    /** Identity facts accumulated for the audit record of this request. */
    actor: AuditActor;
    /** False when a pre-authentication reject must not consume durable audit capacity. */
    durableAudit: boolean;
    principal?: Principal;
    browserSession?: BrowserSession;
    /** Owner credential version observed at authentication; writes re-check it after the body arrives. */
    credentialVersion?: number;
  }
}

export const hashQuery = (query: string) => createHash('sha256').update(query).digest('hex');

export interface AppConfig {
  dataDir: string;
  credentialKey: Buffer;
  codeupEndpoint: string;
  organizationId?: string;
  allowedGitHosts: string[];
  allowedHosts: string[];
  allowedOrigins?: string[];
  feishu?: FeishuConfig;
  writeUsers: string[];
  codegraphBin: string;
  reconcileMs?: number;
  /** Monitoring credential loaded by the caller from a protected secret source. */
  metricsToken?: string;
  /** Disable the legacy public MCP endpoint when the dedicated service is enabled. */
  publicMcpDisabled?: boolean;
  /** Serve Swagger UI and /openapi.json; disabled in production by default. */
  docsEnabled?: boolean;
  /** Directory with the built console (web/dist); the console is served under /ui when set. */
  uiDir?: string;
  /** MCP endpoint shown by the console; defaults to the page origin plus /mcp. */
  uiMcpUrl?: string;
  /** Take the client address from the last X-Forwarded-For hop set by a trusted reverse proxy. */
  trustProxy?: boolean;
  /** Maximum age of a cached Codeup permission check before it is re-verified (default 6h). */
  accessTtlMs?: number;
  /** Per-key MCP request budget per minute (default 120). */
  mcpKeyRatePerMinute?: number;
  /** Failed bearer authentications tolerated per client address per minute (default 30). */
  authFailureRatePerMinute?: number;
  /** Durable audit retention (default 180 days). */
  auditRetentionDays?: number;
}

/** Everything route modules need; built once by createApp. */
export interface AppContext {
  config: AppConfig;
  store: StoreBackend;
  cipher: CredentialCipher;
  codeup: CodeupClient;
  graph: GraphClient;
  worker: Pick<IndexWorker, 'enqueue' | 'kick'>;
  authorization: Authorization;
  metrics: HttpMetrics;
  limiters: { bind: RateLimiter; oauth: RateLimiter; authFailure: RateLimiter; mcpKey: RateLimiter };
  sessionService?: BrowserSessionService;
  probe: (request: IndexRequest, signal?: AbortSignal) => Promise<boolean>;
  clientIp(request: Pick<IncomingMessage, 'headers' | 'socket'>): string;
  fenced(): Record<string, boolean>;
  auditStats(): { dropped: number; failed: number } | undefined;
}
