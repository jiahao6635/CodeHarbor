import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Authorization } from './authorization.js';
import type { AppContext } from './http/context.js';
import { fail } from './http/errors.js';
import { singleQuery, text } from './http/validation.js';
import type { AccountRecord, StoreAccess, StoreBackend } from './store.js';

const AUTHORIZATION_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
const TOKEN_URL = 'https://accounts.feishu.cn/oauth/v3/token';
const USER_INFO_URL = 'https://open.feishu.cn/open-apis/authen/v1/user_info';
const CALLBACK_PATH = '/api/v1/auth/feishu/callback';
const LOGIN_PATH = '/ui/login';
const FLOW_MS = 5 * 60_000;
const SESSION_MS = 8 * 3_600_000;
const PROVIDER_TIMEOUT_MS = 10_000;
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export type FeishuConfig = {
  origin: string;
  appId: string;
  appSecret: string;
  tenantKey: string;
  superAdminOpenId: string;
};

export type BrowserSession = { account: AccountRecord; sessionHash: string };

const callbackQuery = z.object({
  state: singleQuery(z.string().regex(TOKEN_FORMAT)),
  code: singleQuery(z.string().regex(/^[A-Za-z0-9_-]{1,512}$/)).optional(),
  error: singleQuery(text(128)).optional(),
});
const tokenResponse = z.object({ code: z.literal(0), access_token: z.string().min(1).max(16_384) });
const identityResponse = z.object({
  code: z.literal(0),
  data: z.object({
    open_id: z.string().regex(/^ou_[A-Za-z0-9_-]{1,128}$/),
    tenant_key: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    name: text(255),
  }),
});

const randomToken = () => randomBytes(32).toString('base64url');
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

function readTokenCookie(request: FastifyRequest, name: string): string | undefined {
  const values = request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (values?.length !== 1) return undefined;
  const value = values[0].slice(name.length + 1);
  return TOKEN_FORMAT.test(value) ? value : undefined;
}

export class BrowserSessionService {
  private readonly secure: boolean;
  private readonly sessionCookie: string;
  private readonly flowCookie: string;
  private readonly redirectUri: string;

  constructor(
    private readonly config: FeishuConfig,
    private readonly store: StoreBackend,
    private readonly mutate: Authorization['mutate'],
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.secure = config.origin.startsWith('https://');
    const prefix = this.secure ? '__Host-' : '';
    this.sessionCookie = `${prefix}codeharbor_session`;
    this.flowCookie = `${prefix}codeharbor_oauth`;
    this.redirectUri = new URL(CALLBACK_PATH, config.origin).href;
  }

  private cookie(name: string, token: string, lifetimeMs: number): string {
    const secure = this.secure ? '; Secure' : '';
    return `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${lifetimeMs / 1000}${secure}`;
  }

  private assertOrigin(request: FastifyRequest): void {
    if (request.headers.origin !== this.config.origin) fail(403, 'FORBIDDEN');
  }

  async start(reply: FastifyReply): Promise<FastifyReply> {
    const state = randomToken();
    const browserToken = randomToken();
    const verifier = randomToken();
    const now = Date.now();
    await this.store.purgeExpiredBrowserAuth(now);
    await this.store.createFeishuOAuthState({
      state_hash: hashToken(state),
      browser_hash: hashToken(browserToken),
      code_verifier: verifier,
      expires_at: now + FLOW_MS,
    });
    const authorization = new URL(AUTHORIZATION_URL);
    authorization.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.appId,
      redirect_uri: this.redirectUri,
      target_tenant: this.config.tenantKey,
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return reply
      .header('referrer-policy', 'no-referrer')
      .header('set-cookie', this.cookie(this.flowCookie, browserToken, FLOW_MS))
      .redirect(authorization.href);
  }

  private async getIdentity(code: string, verifier: string) {
    try {
      const token = await this.fetcher(TOKEN_URL, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: this.config.appId,
          client_secret: this.config.appSecret,
          code,
          redirect_uri: this.redirectUri,
          code_verifier: verifier,
        }),
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      if (!token.ok) return undefined;
      const parsedToken = tokenResponse.safeParse(await token.json());
      if (!parsedToken.success) return undefined;

      const user = await this.fetcher(USER_INFO_URL, {
        headers: { accept: 'application/json', authorization: `Bearer ${parsedToken.data.access_token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      if (!user.ok) return undefined;
      const identity = identityResponse.safeParse(await user.json());
      if (identity.success && identity.data.data.tenant_key === this.config.tenantKey) return identity.data.data;
    } catch {
      // Upstream failures and response bodies must never include provider credentials in logs or responses.
    }
    return undefined;
  }

  async callback(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    reply.header('referrer-policy', 'no-referrer');
    const input = callbackQuery.safeParse(request.query);
    const browserToken = readTokenCookie(request, this.flowCookie);
    const failed = (reason = 'login_failed') => reply.redirect(`${LOGIN_PATH}?error=${reason}`);
    if (!input.success || !browserToken) return failed();
    const verifier = await this.store.consumeFeishuOAuthState(
      hashToken(input.data.state),
      hashToken(browserToken),
      Date.now(),
    );
    if (!verifier) return failed();
    reply.header('set-cookie', this.cookie(this.flowCookie, '', 0));
    if (input.data.error === 'access_denied') return failed('access_denied');
    if (input.data.error || !input.data.code) return failed();
    const identity = await this.getIdentity(input.data.code, verifier);
    if (!identity) return failed();

    const sessionToken = randomToken();
    const previousToken = readTokenCookie(request, this.sessionCookie);
    const account = await this.mutate(() =>
      this.store.transaction(async (tx) => {
        const canBootstrap =
          identity.open_id === this.config.superAdminOpenId &&
          !(await tx.listAccounts()).some((entry) => entry.role === 'super_admin' && entry.status === 'active');
        const account = await tx.upsertFeishuAccount({
          id: randomUUID(),
          name: identity.name,
          feishu_open_id: identity.open_id,
          feishu_tenant_key: identity.tenant_key,
          role: canBootstrap ? 'super_admin' : 'member',
        });
        if (account.status === 'disabled') return account;
        if (previousToken) await tx.deleteBrowserSession(hashToken(previousToken));
        await tx.createBrowserSession({
          hash: hashToken(sessionToken),
          account_id: account.id,
          expires_at: Date.now() + SESSION_MS,
        });
        return account;
      }),
    );

    request.actor = { ...request.actor, subject: account.id, authentication: 'feishu_session' };
    if (account.status === 'disabled') return failed('account_disabled');
    return reply
      .header('set-cookie', this.cookie(this.sessionCookie, sessionToken, SESSION_MS))
      .redirect('/ui/repositories');
  }

  async authenticate(request: FastifyRequest): Promise<BrowserSession> {
    const token = readTokenCookie(request, this.sessionCookie);
    if (!token) fail(401, 'UNAUTHENTICATED');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) this.assertOrigin(request);
    const sessionHash = hashToken(token);
    return { account: await this.currentAccount(sessionHash, this.store), sessionHash };
  }

  private async currentAccount(sessionHash: string, store: StoreAccess): Promise<AccountRecord> {
    const session = await store.getBrowserSession(sessionHash);
    if (!session || session.expires_at <= Date.now()) fail(401, 'UNAUTHENTICATED');
    const account = await store.getAccount(session.account_id);
    if (account?.status !== 'active') fail(401, 'UNAUTHENTICATED');
    return account;
  }

  async assertCurrent(session: BrowserSession, store: StoreAccess = this.store): Promise<AccountRecord> {
    const account = await this.currentAccount(session.sessionHash, store);
    if (account.id !== session.account.id) fail(401, 'UNAUTHENTICATED');
    return account;
  }

  async signOut(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    this.assertOrigin(request);
    const token = readTokenCookie(request, this.sessionCookie);
    if (token) {
      const hash = hashToken(token);
      const session = await this.store.getBrowserSession(hash);
      if (session) {
        await this.store.deleteBrowserSession(hash);
        request.actor = { ...request.actor, subject: session.account_id, authentication: 'feishu_session' };
      }
    }
    return reply
      .header('set-cookie', this.cookie(this.sessionCookie, '', 0))
      .code(204)
      .send();
  }
}

export async function requireBrowserSession(ctx: AppContext, request: FastifyRequest): Promise<BrowserSession> {
  if (request.browserSession) return request.browserSession;
  if (!ctx.sessionService) fail(401, 'UNAUTHENTICATED');
  const session = await ctx.sessionService.authenticate(request);
  request.browserSession = session;
  request.actor = { ...request.actor, subject: session.account.id, authentication: 'feishu_session' };
  return session;
}
